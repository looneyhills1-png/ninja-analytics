// common-crawl-sync: on-demand (never scheduled - one admin click per
// domain) zero-cost historical-URL discovery via Common Crawl's public CDX
// API. See _shared/common-crawl.ts for the provider calls themselves.
//
// Scope & safety:
//   * Only a domain already present in this portfolio - one of our own
//     sites, or a domain an admin explicitly added to competitor_domains -
//     can be synced. Arbitrary caller-supplied domains are rejected, both
//     to keep this "targeted data relevant to our tracked sites/competitors"
//     (per CLAUDE.md) and to bound the outbound fetches this function makes.
//   * One Common Crawl monthly snapshot per run (not the full historical
//     archive) plus a small, capped number of live title checks - bounded
//     work, no attempt to mirror Common Crawl.

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError } from "../_shared/errors.ts";
import {
  fetchLatestCrawlId,
  liveCheckPage,
  queryCdxIndex,
} from "../_shared/common-crawl.ts";

const CDX_RECORD_LIMIT = 1000;
const MAX_LIVE_TITLE_CHECKS = 15;

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function timestampToDate(ts: string): string {
  // CDX timestamps are YYYYMMDDHHMMSS.
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, cors);
    }
    const { admin } = await requireAdminMfa(req);

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const rawDomain = body?.domain;
    if (typeof rawDomain !== "string" || rawDomain.trim().length === 0) {
      return json(
        400,
        { ok: false, error: "validation_error", message: "domain is required" },
        cors,
      );
    }
    const domain = normalizeDomain(rawDomain);

    const [{ count: competitorCount }, { data: ownSites }] = await Promise.all([
      admin
        .from("competitor_domains")
        .select("id", { count: "exact", head: true })
        .eq("domain", domain),
      admin.from("sites").select("domain"),
    ]);
    const isOwnSite = (ownSites ?? []).some(
      (s) => normalizeDomain(s.domain) === domain,
    );
    if (!isOwnSite && (competitorCount ?? 0) === 0) {
      return json(
        403,
        {
          ok: false,
          error: "not_tracked",
          message:
            "This domain is not one of our sites or a saved competitor domain.",
        },
        cors,
      );
    }

    const { data: run, error: runInsertError } = await admin
      .from("common_crawl_runs")
      .insert({ domain, status: "running" })
      .select("id")
      .single();
    if (runInsertError) throw runInsertError;

    try {
      const crawlId = await fetchLatestCrawlId();
      const records = await queryCdxIndex(domain, crawlId, CDX_RECORD_LIMIT);

      // Dedupe to one row per URL - keep the most recent timestamp seen for it
      // in this snapshot.
      const byUrl = new Map<
        string,
        { date: string; status: number | null; mime: string | null }
      >();
      for (const r of records) {
        const date = timestampToDate(r.timestamp);
        const existing = byUrl.get(r.url);
        if (!existing || date > existing.date) {
          byUrl.set(r.url, { date, status: r.status, mime: r.mime });
        }
      }

      const { data: existingPages, error: existingError } = await admin
        .from("common_crawl_pages")
        .select("url, first_seen, is_active")
        .eq("domain", domain);
      if (existingError) throw existingError;
      const existingByUrl = new Map(
        (existingPages ?? []).map((p) => [p.url, p]),
      );

      const today = new Date().toISOString().slice(0, 10);
      const newUrls = [...byUrl.keys()].filter((u) => !existingByUrl.has(u));
      const disappearedUrls = [...existingByUrl.keys()].filter(
        (u) => !byUrl.has(u) && existingByUrl.get(u)?.is_active,
      );

      // Best-effort titles for a capped number of newly-discovered pages only
      // - the CDX index itself never carries a title.
      const titleChecks = newUrls.slice(0, MAX_LIVE_TITLE_CHECKS);
      const liveResults = new Map<
        string,
        { statusCode: number | null; title: string | null }
      >();
      for (const url of titleChecks) {
        liveResults.set(url, await liveCheckPage(url));
      }

      const upserts = [...byUrl.entries()].map(([url, rec]) => {
        const existing = existingByUrl.get(url);
        const live = liveResults.get(url);
        return {
          domain,
          url,
          first_seen: existing?.first_seen ?? rec.date,
          last_seen: today,
          cdx_status_code: rec.status,
          last_status_code: live?.statusCode ?? null,
          mime_type: rec.mime,
          title: live?.title ?? null,
          is_active: true,
          last_checked_at: new Date().toISOString(),
        };
      });

      if (upserts.length > 0) {
        const { error: upsertError } = await admin
          .from("common_crawl_pages")
          .upsert(upserts, { onConflict: "domain,url" });
        if (upsertError) throw upsertError;
      }
      if (disappearedUrls.length > 0) {
        const { error: disappearError } = await admin
          .from("common_crawl_pages")
          .update({
            is_active: false,
            last_checked_at: new Date().toISOString(),
          })
          .eq("domain", domain)
          .in("url", disappearedUrls);
        if (disappearError) throw disappearError;
      }

      await admin
        .from("common_crawl_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "success",
          crawl_id: crawlId,
          pages_found: byUrl.size,
          pages_new: newUrls.length,
          pages_disappeared: disappearedUrls.length,
        })
        .eq("id", run.id);

      return json(
        200,
        {
          ok: true,
          domain,
          crawlId,
          pagesFound: byUrl.size,
          pagesNew: newUrls.length,
          pagesDisappeared: disappearedUrls.length,
          titlesChecked: titleChecks.length,
        },
        cors,
      );
    } catch (err) {
      const n = normalizeError(err);
      await admin
        .from("common_crawl_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "failed",
          error_message: n.message,
        })
        .eq("id", run.id);
      throw err;
    }
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
