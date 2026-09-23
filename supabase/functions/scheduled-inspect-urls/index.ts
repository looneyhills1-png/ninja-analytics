// scheduled-inspect-urls: the controlled, quota-respecting scheduled batch
// half of Phase 4 (see notes in supabase/migrations/0017_url_inspections.sql
// and _shared/gsc-url-inspection.ts). Automation-secret triggered by
// pg_cron once daily (invoke_scheduled_url_inspection). Deliberately does
// NOT discover new URLs to track - it only refreshes the most-stale
// already-tracked url_inspections rows per site, a small fixed batch, so
// this can never balloon into "inspect the whole site" regardless of how
// many URLs end up tracked. New URLs are added to the tracker only via the
// on-demand "Inspect" action in the UI, driven by the priority queue.

import { corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAutomationSecret } from "../_shared/auth.ts";
import { normalizeError } from "../_shared/errors.ts";
import { createAdminClient } from "../_shared/database.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { parseSitemapLastmods } from "../_shared/site-crawler.ts";
import { inspectAndStoreUrls } from "../_shared/gsc-url-inspection.ts";

// Small on purpose: this runs once a day, unattended, across every active
// site - CLAUDE.md's "add configurable quotas even for free sources" and
// the Phase 4 brief's "cache results... do not repeatedly inspect unchanged
// URLs... inspect high-priority first" (high-priority selection itself is
// the UI's job; this batch is just steady-state freshness upkeep).
const MAX_URLS_PER_SITE = 8;

async function fetchSiteLastmods(
  websiteUrl: string,
): Promise<Map<string, string>> {
  try {
    const origin = new URL(websiteUrl).origin;
    const res = await fetchWithRetry(
      `${origin}/sitemap.xml`,
      { headers: { "User-Agent": "ninja-analytics-url-inspection/1.0" } },
      { timeoutMs: 15_000, maxRetries: 1 },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return new Map();
    }
    return parseSitemapLastmods(await res.text());
  } catch {
    return new Map();
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  try {
    requireAutomationSecret(req);
    const admin = createAdminClient();

    const { data: sites, error: sitesError } = await admin
      .from("sites")
      .select("id, website_url, gsc_property")
      .eq("is_active", true);
    if (sitesError) throw sitesError;

    const perSite: Array<{
      siteId: string;
      inspected: number;
      skippedCached: number;
      failed: number;
      reason?: string;
    }> = [];

    for (const site of sites ?? []) {
      if (!site.gsc_property) {
        perSite.push({
          siteId: site.id,
          inspected: 0,
          skippedCached: 0,
          failed: 0,
          reason: "no_gsc_property",
        });
        continue;
      }

      const { data: stale, error: staleError } = await admin
        .from("url_inspections")
        .select("url")
        .eq("site_id", site.id)
        .order("last_inspected_at", { ascending: true })
        .limit(MAX_URLS_PER_SITE);
      if (staleError) throw staleError;

      const urls = (stale ?? []).map((r) => r.url as string);
      if (urls.length === 0) {
        perSite.push({
          siteId: site.id,
          inspected: 0,
          skippedCached: 0,
          failed: 0,
          reason: "no_tracked_urls",
        });
        continue;
      }

      const lastmods = site.website_url
        ? await fetchSiteLastmods(site.website_url)
        : new Map<string, string>();
      const siteLastmodByUrl: Record<string, string | null> = {};
      for (const url of urls) siteLastmodByUrl[url] = lastmods.get(url) ?? null;

      const results = await inspectAndStoreUrls(
        admin,
        site.id,
        site.gsc_property,
        urls,
        { inspectedBy: null, siteLastmodByUrl },
      );

      perSite.push({
        siteId: site.id,
        inspected: results.filter((r) => r.status === "inspected").length,
        skippedCached: results.filter((r) => r.status === "skipped_cached")
          .length,
        failed: results.filter((r) => r.status === "failed").length,
      });
    }

    return json(200, { ok: true, sites: perSite }, cors);
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
