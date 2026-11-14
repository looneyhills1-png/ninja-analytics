// ai-readiness-audit: bounded technical audit of our OWN sites for search and
// AI-assistant readiness. Weekly via pg_cron or on demand from the dashboard.
//
// Bounds: owned host only, at most MAX_PAGES pages per site, one request at a
// time per host with a politeness delay, per-request timeout, a global time
// budget, at most one retry, and a minimum interval between runs per site.

import { fetchWithRetry } from "../_shared/http.ts";
import {
  evaluatePage,
  evaluateRobots,
  findDuplicates,
  isOwnedUrl,
  type Finding,
} from "../_shared/ai-readiness.ts";
import {
  extractPageData,
  isLikelySitemapIndex,
  parseSitemapLocs,
} from "../_shared/site-crawler.ts";
import { serveIntel } from "../_shared/intel-common.ts";

const MAX_PAGES = 15;
const MAX_NESTED_SITEMAPS = 2;
const MAX_REDIRECT_HOPS = 5;
const REQUEST_TIMEOUT_MS = 8_000;
const POLITE_DELAY_MS = 600;
const TIME_BUDGET_MS = 110_000;
const MIN_INTERVAL_MS = { scheduled: 5 * 86_400_000, manual: 10 * 60_000 };
const KEEP_RUNS_PER_SITE = 4;
const MAX_HTML_BYTES = 1_500_000;
const UA = "ninja-analytics-readiness/1.0 (owner self-audit)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string) {
  return await fetchWithRetry(
    url,
    { headers: { "User-Agent": UA }, redirect: "manual" },
    { timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 1 },
  );
}

async function readText(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
}

/** Follow redirects by hand so hops are counted and we never leave the host. */
async function fetchFollowing(url: string, domain: string) {
  let current = url;
  let hops = 0;
  for (;;) {
    const res = await get(current);
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location")!, current).href;
      await res.body?.cancel();
      if (!isOwnedUrl(next, domain) || hops >= MAX_REDIRECT_HOPS) {
        return { res: null, finalUrl: next, hops: hops + 1, left: true };
      }
      hops += 1;
      current = next;
      await sleep(POLITE_DELAY_MS);
      continue;
    }
    return { res, finalUrl: current, hops, left: false };
  }
}

function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

serveIntel(async ({ admin, trigger, body }) => {
  const started = Date.now();
  let q = admin
    .from("sites")
    .select("id, domain, website_url")
    .eq("is_active", true);
  if (typeof body.siteId === "string") q = q.eq("id", body.siteId);
  const { data: sites, error } = await q;
  if (error) throw error;

  const results: Array<Record<string, unknown>> = [];
  for (const site of sites ?? []) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      results.push({ siteId: site.id, skipped: "time_budget" });
      continue;
    }
    const { data: recent } = await admin
      .from("ai_readiness_runs")
      .select("started_at")
      .eq("site_id", site.id)
      .order("started_at", { ascending: false })
      .limit(1);
    const lastAt = recent?.[0]?.started_at as string | undefined;
    if (
      lastAt &&
      Date.now() - new Date(lastAt).getTime() < MIN_INTERVAL_MS[trigger]
    ) {
      results.push({ siteId: site.id, skipped: "recent_run" });
      continue;
    }

    let origin: string;
    try {
      origin = new URL(site.website_url || `https://${site.domain}`).origin;
    } catch {
      results.push({ siteId: site.id, skipped: "bad_url" });
      continue;
    }
    if (!isOwnedUrl(origin, site.domain)) {
      results.push({ siteId: site.id, skipped: "not_owned_host" });
      continue;
    }

    const { data: run, error: runErr } = await admin
      .from("ai_readiness_runs")
      .insert({ site_id: site.id, trigger_type: trigger })
      .select("id")
      .single();
    if (runErr) throw runErr;

    const findings: Finding[] = [];
    let pagesChecked = 0;
    let status: "success" | "partial" | "failed" = "success";
    try {
      // robots.txt
      let robotsText: string | null = null;
      let robotsStatus: number | null = null;
      try {
        const r = await get(`${origin}/robots.txt`);
        robotsStatus = r.status;
        robotsText =
          r.status < 300 ? await readText(r) : (await r.body?.cancel(), "");
      } catch {
        robotsStatus = null;
      }
      const robots = evaluateRobots(robotsText, robotsStatus, origin);
      findings.push(...robots.findings);

      // sitemap(s)
      const sitemapUrls = (
        robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`]
      )
        .filter((u) => isOwnedUrl(u, site.domain))
        .slice(0, 1 + MAX_NESTED_SITEMAPS);
      const locs: string[] = [];
      let sitemapOk = false;
      const queue = [...sitemapUrls];
      let nested = 0;
      while (queue.length && Date.now() - started < TIME_BUDGET_MS) {
        const sm = queue.shift()!;
        await sleep(POLITE_DELAY_MS);
        try {
          const r = await get(sm);
          if (r.status >= 400 || r.status >= 300) {
            await r.body?.cancel();
            findings.push({
              checkKey: "sitemap_unreachable",
              severity: "error",
              url: sm,
              message: `Sitemap returned HTTP ${r.status}.`,
              evidence: { status: r.status },
            });
            continue;
          }
          const xml = await readText(r);
          sitemapOk = true;
          const found = parseSitemapLocs(xml).filter((u) =>
            isOwnedUrl(u, site.domain),
          );
          if (isLikelySitemapIndex(xml)) {
            for (const child of found) {
              if (nested < MAX_NESTED_SITEMAPS) {
                nested += 1;
                queue.push(child);
              }
            }
          } else {
            locs.push(...found);
          }
        } catch {
          findings.push({
            checkKey: "sitemap_unreachable",
            severity: "error",
            url: sm,
            message: "Sitemap could not be fetched (network error or timeout).",
          });
        }
      }
      if (sitemapOk && locs.length === 0) {
        findings.push({
          checkKey: "sitemap_empty",
          severity: "warning",
          url: sitemapUrls[0] ?? null,
          message: "Sitemap contains no URLs for this site.",
        });
      }

      // pages: home + an even sample of sitemap URLs
      const targets = [
        origin + "/",
        ...sample(
          [...new Set(locs)].filter((u) => u !== origin && u !== origin + "/"),
          MAX_PAGES - 1,
        ),
      ];
      const dupInput: Array<{
        url: string;
        contentHash: string;
        wordCount: number;
      }> = [];
      for (const url of targets) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          status = "partial";
          break;
        }
        await sleep(POLITE_DELAY_MS);
        pagesChecked += 1;
        try {
          const { res, finalUrl, hops, left } = await fetchFollowing(
            url,
            site.domain,
          );
          if (left || !res) {
            findings.push({
              checkKey: "redirect_offsite",
              severity: "warning",
              url,
              message: `Redirects away from the site (to ${finalUrl}) or exceeds ${MAX_REDIRECT_HOPS} hops.`,
              evidence: { hops },
            });
            continue;
          }
          const ct = res.headers.get("content-type") ?? "";
          const html =
            res.status < 400 && /html/i.test(ct)
              ? await readText(res)
              : (await res.body?.cancel(), null);
          findings.push(
            ...evaluatePage({
              url,
              status: res.status,
              finalUrl: finalUrl !== url ? finalUrl : null,
              redirectHops: hops,
              xRobotsTag: res.headers.get("x-robots-tag"),
              html,
            }),
          );
          if (html) {
            const d = extractPageData(html, finalUrl);
            dupInput.push({
              url,
              contentHash: d.contentHash,
              wordCount: d.wordCount,
            });
          }
        } catch {
          findings.push(...evaluatePage({ url, status: null, html: null }));
        }
      }
      findings.push(...findDuplicates(dupInput));
    } catch {
      status = "failed";
    }

    if (
      status === "success" &&
      findings.some((f) => f.checkKey === "page_unreachable")
    ) {
      status = "partial";
    }
    const checkedAt = new Date().toISOString();
    if (findings.length) {
      const { error: fErr } = await admin.from("ai_readiness_findings").insert(
        findings.map((f) => ({
          run_id: run.id,
          site_id: site.id,
          check_key: f.checkKey,
          severity: f.severity,
          url: f.url,
          message: f.message,
          evidence: f.evidence ?? {},
          checked_at: checkedAt,
        })),
      );
      if (fErr) status = "failed";
    }
    await admin
      .from("ai_readiness_runs")
      .update({
        finished_at: checkedAt,
        status,
        pages_checked: pagesChecked,
        error_code: status === "failed" ? "audit_failed" : null,
      })
      .eq("id", run.id);

    // Keep only the most recent runs per site.
    const { data: old } = await admin
      .from("ai_readiness_runs")
      .select("id")
      .eq("site_id", site.id)
      .order("started_at", { ascending: false })
      .range(KEEP_RUNS_PER_SITE, KEEP_RUNS_PER_SITE + 50);
    if (old?.length) {
      await admin
        .from("ai_readiness_runs")
        .delete()
        .in(
          "id",
          old.map((o) => o.id),
        );
    }

    results.push({
      siteId: site.id,
      runId: run.id,
      status,
      pagesChecked,
      findings: findings.filter((f) => f.severity !== "ok").length,
    });
  }
  return { trigger, results };
});
