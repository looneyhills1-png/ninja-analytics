// coverage-sync: one bounded, incremental pass over every active site that
//   1. DISCOVERS URLs from robots.txt/sitemaps (index + children), Search
//      Console pages, the latest site audit, earlier inspections and internal
//      links found on pages it checks (no recursion within a run);
//   2. LIVE-CHECKS the stalest URLs (status, redirect, canonical, robots,
//      title, description, schema, word count) - Ninja Analytics' own view;
//   3. INSPECTS the stalest URLs with Google's URL Inspection API - Google's
//      view, stored separately (url_inspections, unchanged);
//   4. reads Google's own sitemap status and, weekly, Search Analytics by
//      device / country / search type;
//   5. writes a coverage snapshot so changes can be compared over time.
//
// Everything is finite: per-run budgets for pages, inspections and sitemaps,
// a wall-clock budget, politely paced requests, at most two retries, and
// staleness rules so a daily run only does what is due. Read-only toward the
// websites and toward Google. Triggered by the automation secret (daily cron)
// or by an admin for an on-demand check of one site.

import { fetchAllRows, serveIntel } from "../_shared/intel-common.ts";
import {
  applyLiveCanonical,
  allowedHosts,
  headerNoindex,
  inspectionQueue,
  LIMITS,
  liveQueue,
  mergeInventory,
  normalizeUrl,
  summariseCoverage,
  type Discovered,
  type InspectionFact,
  type InventoryRow,
  type Source,
} from "../_shared/coverage.ts";
import {
  extractPageData,
  isDisallowed,
  isLikelySitemapIndex,
  parseRobotsTxt,
  parseSitemapLocs,
} from "../_shared/site-crawler.ts";
import { inspectAndStoreUrls } from "../_shared/gsc-url-inspection.ts";
import { fetchPublic } from "../_shared/public-url.ts";
import {
  listSitemaps,
  queryByDimension,
  type Dimension,
  type SearchType,
} from "../_shared/gsc-api.ts";

const UA = "ninja-analytics-coverage/1.0 (own-site check)";
const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, ms = 15_000): Promise<string | null> {
  try {
    // robots.txt may name any sitemap URL, so keep this on the public web.
    const { response: res } = await fetchPublic(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.text()).slice(0, 5_000_000);
  } catch {
    return null;
  }
}

serveIntel(async ({ admin, trigger, body }) => {
  const started = Date.now();
  // An on-demand call goes through the dashboard proxy (60 s), a scheduled
  // one has the runtime's 150 s idle limit; each keeps a safety margin.
  const budgetMs = trigger === "manual" ? 45_000 : LIMITS.budgetMs;
  const overBudget = () => Date.now() - started > budgetMs;
  const now = new Date();
  const doLive = body.live !== false;
  const doInspect = body.inspect !== false;
  const doDimensions = body.dimensions !== false;

  let q = admin
    .from("sites")
    .select("id, name, domain, website_url, gsc_property")
    .eq("is_active", true)
    .order("name");
  if (typeof body.siteId === "string") q = q.eq("id", body.siteId);
  const { data: sites, error } = await q;
  if (error) throw error;

  const report: Array<Record<string, unknown>> = [];

  for (const site of sites ?? []) {
    if (overBudget()) {
      report.push({ site: site.name, skipped: "time_budget" });
      continue;
    }
    const out: Record<string, unknown> = { site: site.name };
    report.push(out);
    // Each site gets an equal share of the run so a large site cannot starve
    // the others of their daily bounded pass.
    const siteStart = Date.now();
    const siteBudget = Math.max(
      25_000,
      Math.floor(budgetMs / Math.max(1, sites?.length ?? 1)),
    );
    const siteOver = () => Date.now() - siteStart > siteBudget;
    const liveDeadline = siteStart + siteBudget * 0.4;
    const inspectDeadline = siteStart + siteBudget - 6_000;
    const hosts = allowedHosts(site.website_url ?? "", site.domain);
    let origin: string;
    try {
      origin = new URL(site.website_url).origin;
    } catch {
      out.skipped = "no_valid_website_url";
      continue;
    }

    // ---- existing inventory --------------------------------------------
    const dbRows = await fetchAllRows<Record<string, unknown>>((from, to) =>
      admin
        .from("url_inventory")
        .select("*")
        .eq("site_id", site.id)
        .order("url")
        .range(from, to),
    );
    const existing: InventoryRow[] = dbRows.map((r) => ({
      url: r.url as string,
      sources: (r.sources as Source[]) ?? [],
      inSitemap: !!r.in_sitemap,
      isAlias: !!r.is_alias,
      canonicalGroup: (r.canonical_group as string) ?? null,
      liveCheckedAt: (r.live_checked_at as string) ?? null,
      liveStatus: (r.live_status as number) ?? null,
      liveRedirectTo: (r.live_redirect_to as string) ?? null,
      liveCanonical: (r.live_canonical as string) ?? null,
      liveNoindex: (r.live_noindex as boolean) ?? null,
      liveWordCount: (r.live_word_count as number) ?? null,
      liveTitle: (r.live_title as string) ?? null,
      liveError: (r.live_error as string) ?? null,
      robotsAllowed: (r.robots_allowed as boolean) ?? null,
    }));

    // ---- discovery ------------------------------------------------------
    const found: Discovered[] = [];
    const robotsText = await getText(`${origin}/robots.txt`);
    const robots = robotsText
      ? parseRobotsTxt(robotsText)
      : { disallow: [], sitemaps: [] };

    const queue = [...new Set([`${origin}/sitemap.xml`, ...robots.sitemaps])];
    const seenMaps = new Set<string>();
    let sitemapUrls = 0;
    while (queue.length && seenMaps.size < LIMITS.maxSitemaps && !siteOver()) {
      const m = queue.shift() as string;
      if (seenMaps.has(m)) continue;
      seenMaps.add(m);
      const xml = await getText(m);
      if (!xml) continue;
      const locs = parseSitemapLocs(xml);
      if (isLikelySitemapIndex(xml)) {
        for (const child of locs) queue.push(child);
      } else {
        for (const loc of locs) {
          if (sitemapUrls >= LIMITS.maxSitemapUrls) break;
          sitemapUrls += 1;
          found.push({ url: loc, source: "sitemap" });
        }
      }
    }
    out.sitemapsRead = seenMaps.size;
    out.sitemapUrls = sitemapUrls;

    // Search Console pages (last 28 days of stored data, google engine).
    const gscSince = isoDate(new Date(now.getTime() - 28 * DAY));
    const gscRows = await fetchAllRows<{ page: string }>(
      (from, to) =>
        admin
          .from("search_page_daily")
          .select("page")
          .eq("site_id", site.id)
          .eq("engine", "google")
          .gte("metric_date", gscSince)
          .order("metric_date")
          .order("page")
          .range(from, to),
      1000,
      30_000,
    );
    const gscPages = new Set(gscRows.map((r) => r.page));
    let n = 0;
    for (const p of gscPages) {
      if (n++ >= LIMITS.maxGscPages) break;
      found.push({ url: p, source: "gsc" });
    }

    // Latest finished site audit (pages it crawled) and earlier inspections.
    const { data: auditRun } = await admin
      .from("site_audit_runs")
      .select("id")
      .eq("site_id", site.id)
      .eq("status", "success")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (auditRun) {
      const pages = await fetchAllRows<{ url: string }>((from, to) =>
        admin
          .from("site_audit_pages")
          .select("url")
          .eq("run_id", auditRun.id)
          .order("url")
          .range(from, to),
      );
      for (const p of pages) found.push({ url: p.url, source: "audit" });
    }
    const known = await fetchAllRows<{ url: string }>((from, to) =>
      admin
        .from("url_inspections")
        .select("url")
        .eq("site_id", site.id)
        .order("url")
        .range(from, to),
    );
    for (const k of known) found.push({ url: k.url, source: "inspection" });

    let merged = mergeInventory(existing, found, hosts);
    let rows = merged.rows;
    let discoveredNew = merged.added;

    // ---- live checks (own requests, politely paced) ---------------------
    const touched = new Set<string>();
    if (doLive) {
      const todo = liveQueue(rows, now);
      const byUrl = new Map(rows.map((r) => [r.url, r]));
      const harvested: Discovered[] = [];
      let checked = 0;
      for (const url of todo) {
        if (Date.now() > liveDeadline) break;
        const r = byUrl.get(url) as InventoryRow;
        const path = new URL(url).pathname;
        r.robotsAllowed = !isDisallowed(path, robots.disallow);
        try {
          const res = await fetch(url, {
            redirect: "manual",
            headers: { "User-Agent": UA, Accept: "text/html" },
            signal: AbortSignal.timeout(12_000),
          });
          r.liveStatus = res.status;
          r.liveError = null;
          const loc = res.headers.get("location");
          r.liveRedirectTo = loc ? normalizeUrl(loc, url) : null;
          const xrt = res.headers.get("x-robots-tag");
          const ctype = res.headers.get("content-type") ?? "";
          if (res.status === 200 && ctype.includes("text/html")) {
            const html = (await res.text()).slice(0, 600_000);
            const d = extractPageData(html, url);
            r.liveCanonical = d.canonicalUrl;
            r.liveNoindex = d.metaRobotsNoindex || headerNoindex(xrt);
            r.liveWordCount = d.wordCount;
            r.liveTitle = d.title;
            for (const l of d.internalLinks.slice(0, LIMITS.maxLinksPerPage)) {
              harvested.push({ url: l, source: "internal_link" });
            }
            // Description / schema are kept on the row for the detail view.
            (r as InventoryRow & { _desc?: string | null })._desc =
              d.metaDescription;
            (r as InventoryRow & { _schema?: boolean })._schema = d.hasSchema;
          } else {
            await res.body?.cancel();
            r.liveNoindex = headerNoindex(xrt);
          }
        } catch (e) {
          r.liveStatus = null;
          r.liveError = e instanceof Error ? e.message.slice(0, 160) : "failed";
        }
        r.liveCheckedAt = new Date().toISOString();
        byUrl.set(url, applyLiveCanonical(r));
        touched.add(url);
        checked += 1;
        await sleep(400);
      }
      rows = [...byUrl.values()];
      // Links found are queued for the NEXT run, never followed now.
      const again = mergeInventory(rows, harvested, hosts);
      rows = again.rows;
      discoveredNew += again.added;
      out.liveChecked = checked;
    }

    // ---- persist inventory ----------------------------------------------
    const nowIso = new Date().toISOString();
    const before = new Map(existing.map((r) => [r.url, r]));
    const changed = (r: InventoryRow) => {
      const o = before.get(r.url);
      return (
        !o ||
        o.sources.length !== r.sources.length ||
        o.inSitemap !== r.inSitemap ||
        o.isAlias !== r.isAlias
      );
    };
    const payload = rows
      .filter((r) => touched.has(r.url) || changed(r))
      .map((r) => {
        const ext = r as InventoryRow & {
          _desc?: string | null;
          _schema?: boolean;
        };
        return {
          site_id: site.id,
          url: r.url,
          sources: r.sources,
          last_seen_at: nowIso,
          in_sitemap: r.inSitemap,
          is_alias: r.isAlias,
          canonical_group: r.canonicalGroup,
          live_checked_at: r.liveCheckedAt,
          live_status: r.liveStatus,
          live_redirect_to: r.liveRedirectTo,
          live_canonical: r.liveCanonical,
          live_noindex: r.liveNoindex,
          live_title: r.liveTitle ?? null,
          ...(ext._desc !== undefined ? { live_description: ext._desc } : {}),
          ...(ext._schema !== undefined
            ? { live_has_schema: ext._schema }
            : {}),
          live_word_count: r.liveWordCount,
          live_error: r.liveError,
          robots_allowed: r.robotsAllowed,
        };
      });
    for (let i = 0; i < payload.length; i += 200) {
      const { error: upErr } = await admin
        .from("url_inventory")
        .upsert(payload.slice(i, i + 200), { onConflict: "site_id,url" });
      if (upErr) throw upErr;
    }
    out.discovered = rows.length;
    out.newlyDiscovered = discoveredNew;

    // ---- Google: sitemap status, then URL inspections -------------------
    if (site.gsc_property) {
      try {
        const maps = await listSitemaps(site.gsc_property);
        if (maps.length) {
          await admin.from("gsc_sitemaps").upsert(
            maps.map((m) => ({
              site_id: site.id,
              path: m.path,
              last_submitted: m.lastSubmitted,
              last_downloaded: m.lastDownloaded,
              is_pending: m.isPending,
              is_sitemaps_index: m.isSitemapsIndex,
              warnings: m.warnings,
              errors: m.errors,
              contents: m.contents,
              checked_at: nowIso,
            })),
            { onConflict: "site_id,path" },
          );
        }
        out.googleSitemaps = maps.length;
      } catch (e) {
        out.googleSitemapsError =
          e instanceof Error ? e.message.slice(0, 200) : "failed";
      }

      // Weekly Search Analytics by device, country and search type.
      if (doDimensions) {
        const { data: lastSnap } = await admin
          .from("search_dimension_snapshots")
          .select("captured_at")
          .eq("site_id", site.id)
          .order("captured_at", { ascending: false })
          .limit(1);
        const due =
          !lastSnap?.[0] ||
          now.getTime() - new Date(lastSnap[0].captured_at).getTime() >
            6 * DAY ||
          body.force === true;
        if (due) {
          // Search Console data is final ~3 days late.
          const end = isoDate(new Date(now.getTime() - 3 * DAY));
          const start = isoDate(new Date(now.getTime() - 30 * DAY));
          const jobs: Array<{
            dim: Dimension;
            type: SearchType;
            label: string;
          }> = [
            { dim: "device", type: "web", label: "web" },
            { dim: "country", type: "web", label: "web" },
            { dim: "device", type: "image", label: "image" },
            { dim: "device", type: "video", label: "video" },
            { dim: "device", type: "news", label: "news" },
          ];
          const snap: Array<Record<string, unknown>> = [];
          let dimErr: string | null = null;
          for (const j of jobs) {
            try {
              const rowsD = await queryByDimension(site.gsc_property, {
                startDate: start,
                endDate: end,
                dimension: j.dim,
                searchType: j.type,
              });
              for (const r of rowsD) {
                snap.push({
                  site_id: site.id,
                  captured_at: nowIso,
                  window_start: start,
                  window_end: end,
                  dimension: j.type === "web" ? j.dim : "search_type",
                  key: j.type === "web" ? r.key : `${j.label}:${r.key}`,
                  clicks: r.clicks,
                  impressions: r.impressions,
                  ctr: r.ctr,
                  position: r.position,
                });
              }
            } catch (e) {
              dimErr = e instanceof Error ? e.message.slice(0, 200) : "failed";
            }
          }
          if (snap.length) {
            await admin.from("search_dimension_snapshots").insert(snap);
          }
          out.dimensionRows = snap.length;
          if (dimErr) out.dimensionError = dimErr;
        }
      }
      if (doInspect) {
        const lastInspected = new Map<string, string>();
        const insp = await fetchAllRows<{
          url: string;
          last_inspected_at: string;
        }>((from, to) =>
          admin
            .from("url_inspections")
            .select("url, last_inspected_at")
            .eq("site_id", site.id)
            .order("url")
            .range(from, to),
        );
        for (const i of insp) lastInspected.set(i.url, i.last_inspected_at);
        const toInspect = inspectionQueue(rows, lastInspected, now);
        let attempted = 0;
        let inspectedOk = 0;
        let failed = 0;
        let firstError: string | null = null;
        // Small chunks so the time budget is checked between them.
        for (let i = 0; i < toInspect.length; i += 4) {
          if (Date.now() > inspectDeadline) break;
          const chunk = toInspect.slice(i, i + 4);
          const results = await inspectAndStoreUrls(
            admin,
            site.id,
            site.gsc_property,
            chunk,
            { inspectedBy: null },
          );
          attempted += chunk.length;
          inspectedOk += results.filter((r) => r.status === "inspected").length;
          const bad = results.filter((r) => r.status === "failed");
          failed += bad.length;
          firstError ??= bad[0]?.errorMessage?.slice(0, 200) ?? null;
          // A quota or permission failure will repeat; stop instead of retrying.
          if (bad.length === chunk.length) break;
        }
        out.inspectionQueue = toInspect.length;
        out.inspectionsAttempted = attempted;
        out.inspected = inspectedOk;
        out.inspectionFailed = failed;
        if (firstError) out.inspectionError = firstError;
      }
    } else {
      out.googleSkipped = "no_gsc_property";
    }

    // ---- snapshot --------------------------------------------------------
    const latestInsp = await fetchAllRows<{
      url: string;
      ninja_status: string;
      coverage_state: string | null;
      last_crawl_time: string | null;
      last_inspected_at: string;
      google_canonical: string | null;
      user_canonical: string | null;
    }>((from, to) =>
      admin
        .from("url_inspections")
        .select(
          "url, ninja_status, coverage_state, last_crawl_time, last_inspected_at, google_canonical, user_canonical",
        )
        .eq("site_id", site.id)
        .order("url")
        .range(from, to),
    );
    const facts = new Map<string, InspectionFact>(
      latestInsp.map((i) => [
        i.url,
        {
          ninjaStatus: i.ninja_status,
          coverageState: i.coverage_state,
          lastCrawlTime: i.last_crawl_time,
          lastInspectedAt: i.last_inspected_at,
          googleCanonical: i.google_canonical,
          userCanonical: i.user_canonical,
        },
      ]),
    );
    const summary = summariseCoverage(rows, facts);
    await admin.from("coverage_snapshots").insert({
      site_id: site.id,
      discovered: summary.discovered,
      live_checked: summary.liveChecked,
      inspected: summary.inspected,
      indexed: summary.indexedAmongInspected,
      excluded: summary.excludedAmongInspected,
      unknown_state: summary.unknownAmongInspected,
      technical_errors: summary.technicalErrors.length,
      complete: summary.complete,
      detail: {
        indexedTotal: summary.indexedTotal,
        excludedTotal: summary.excludedTotal,
        excludedByReason: summary.excludedByReason,
        technicalErrors: summary.technicalErrors.slice(0, 50),
      },
    });
    out.summary = {
      discovered: summary.discovered,
      liveChecked: summary.liveChecked,
      inspected: summary.inspected,
      indexed: summary.indexedAmongInspected,
      excluded: summary.excludedAmongInspected,
      complete: summary.complete,
    };
  }

  return {
    trigger,
    sites: report,
    elapsedMs: Date.now() - started,
    truncated: Date.now() - started > budgetMs,
  };
});
