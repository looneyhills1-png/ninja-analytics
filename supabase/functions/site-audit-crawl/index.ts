// site-audit-crawl: on-demand (never scheduled) generic crawler for one of
// our own sites (CLAUDE.md Phase 5). Admin+aal2 triggered, same trust model
// as manual-sync. Bounded BFS same-origin crawl - never an unbounded
// scraper, never a competitor's site (only a domain in the sites table).

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError, sanitizeMessage } from "../_shared/errors.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import {
  computeHealthScore,
  extractPageData,
  isDisallowed,
  isLikelySitemapIndex,
  parseRobotsTxt,
  parseSitemapLocs,
  resolveLink,
  THIN_CONTENT_WORD_THRESHOLD,
  type ExtractedPage,
} from "../_shared/site-crawler.ts";

const MAX_PAGES = 100;
const MAX_DEPTH = 6;
const CONCURRENCY = 3;
const PAGE_TIMEOUT_MS = 8_000;
const TIME_BUDGET_MS = 100_000;
const MAX_SITEMAP_URLS = 500;
const MAX_NESTED_SITEMAPS = 5;
const MAX_REDIRECT_HOPS = 5;
const USER_AGENT = "ninja-analytics-site-audit/1.0";

interface Issue {
  url: string | null;
  severity: "error" | "warning" | "notice";
  category: string;
  code: string;
  message: string;
}

interface PageRecord {
  url: string;
  statusCode: number | null;
  isRedirect: boolean;
  redirectTarget: string | null;
  crawlDepth: number;
  discoveredFrom: "crawl" | "sitemap";
  data: ExtractedPage | null;
  responseTimeMs: number | null;
}

async function fetchRobots(origin: string) {
  try {
    const res = await fetchWithRetry(
      `${origin}/robots.txt`,
      { headers: { "User-Agent": USER_AGENT } },
      { timeoutMs: PAGE_TIMEOUT_MS, maxRetries: 0 },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return { disallow: [], sitemaps: [] };
    }
    return parseRobotsTxt(await res.text());
  } catch {
    return { disallow: [], sitemaps: [] };
  }
}

async function fetchSitemapUrls(
  origin: string,
  declaredSitemaps: string[],
): Promise<Set<string>> {
  const urls = new Set<string>();
  const queue = [...declaredSitemaps, `${origin}/sitemap.xml`];
  let fetched = 0;
  while (
    queue.length > 0 &&
    fetched < MAX_NESTED_SITEMAPS &&
    urls.size < MAX_SITEMAP_URLS
  ) {
    const sitemapUrl = queue.shift()!;
    fetched += 1;
    try {
      const res = await fetchWithRetry(
        sitemapUrl,
        { headers: { "User-Agent": USER_AGENT } },
        { timeoutMs: PAGE_TIMEOUT_MS, maxRetries: 0 },
      );
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      const xml = await res.text();
      const locs = parseSitemapLocs(xml).slice(0, MAX_SITEMAP_URLS);
      if (isLikelySitemapIndex(xml)) {
        queue.push(...locs);
      } else {
        for (const loc of locs) {
          if (urls.size >= MAX_SITEMAP_URLS) break;
          urls.add(loc);
        }
      }
    } catch {
      // A missing/broken sitemap is itself worth flagging, but not fatal to
      // the crawl - the BFS from the homepage still runs.
    }
  }
  return urls;
}

interface FetchResult {
  statusCode: number | null;
  isRedirect: boolean;
  redirectTarget: string | null;
  html: string | null;
  responseTimeMs: number | null;
}

async function fetchOnePage(url: string): Promise<FetchResult> {
  const startedAt = performance.now();
  try {
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": USER_AGENT }, redirect: "manual" },
      { timeoutMs: PAGE_TIMEOUT_MS, maxRetries: 0 },
    );
    const responseTimeMs = Math.round(performance.now() - startedAt);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      return {
        statusCode: res.status,
        isRedirect: true,
        redirectTarget: location,
        html: null,
        responseTimeMs,
      };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return {
        statusCode: res.status,
        isRedirect: false,
        redirectTarget: null,
        html: null,
        responseTimeMs,
      };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      await res.body?.cancel();
      return {
        statusCode: res.status,
        isRedirect: false,
        redirectTarget: null,
        html: null,
        responseTimeMs,
      };
    }
    // Bounded read - a 2MB budget is generous for on-page audit signals.
    const buf = await res.arrayBuffer();
    const html = new TextDecoder().decode(buf.slice(0, 2_000_000));
    return {
      statusCode: res.status,
      isRedirect: false,
      redirectTarget: null,
      html,
      responseTimeMs,
    };
  } catch (err) {
    void sanitizeMessage(err, 120);
    return {
      statusCode: null,
      isRedirect: false,
      redirectTarget: null,
      html: null,
      responseTimeMs: null,
    };
  }
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
    const siteId = body?.siteId;
    if (typeof siteId !== "string" || siteId.length === 0) {
      return json(
        400,
        { ok: false, error: "validation_error", message: "siteId is required" },
        cors,
      );
    }

    const { data: site, error: siteError } = await admin
      .from("sites")
      .select("id, website_url")
      .eq("id", siteId)
      .maybeSingle();
    if (siteError) throw siteError;
    if (!site) return json(404, { ok: false, error: "not_found" }, cors);

    let homepage: URL;
    try {
      homepage = new URL(site.website_url);
    } catch {
      return json(
        400,
        {
          ok: false,
          error: "validation_error",
          message: "Site has no valid website_url",
        },
        cors,
      );
    }
    const origin = homepage.origin;

    const { data: run, error: runInsertError } = await admin
      .from("site_audit_runs")
      .insert({ site_id: siteId, status: "running" })
      .select("id")
      .single();
    if (runInsertError) throw runInsertError;

    try {
      const result = await runCrawl(origin, homepage.toString());
      const errorsCount = result.issues.filter(
        (i) => i.severity === "error",
      ).length;
      const warningsCount = result.issues.filter(
        (i) => i.severity === "warning",
      ).length;
      const noticesCount = result.issues.filter(
        (i) => i.severity === "notice",
      ).length;
      const healthScore = computeHealthScore(
        errorsCount,
        warningsCount,
        noticesCount,
      );

      if (result.pages.length > 0) {
        const { error: pagesError } = await admin
          .from("site_audit_pages")
          .insert(result.pages.map((p) => pageToRow(run.id, siteId, p)));
        if (pagesError) throw pagesError;
      }
      if (result.issues.length > 0) {
        const { error: issuesError } = await admin
          .from("site_audit_issues")
          .insert(
            result.issues.map((i) => ({
              run_id: run.id,
              site_id: siteId,
              ...i,
            })),
          );
        if (issuesError) throw issuesError;
      }

      await admin
        .from("site_audit_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "success",
          pages_crawled: result.pages.length,
          health_score: healthScore,
          errors_count: errorsCount,
          warnings_count: warningsCount,
          notices_count: noticesCount,
        })
        .eq("id", run.id);

      return json(
        200,
        {
          ok: true,
          runId: run.id,
          pagesCrawled: result.pages.length,
          healthScore,
          errorsCount,
          warningsCount,
          noticesCount,
        },
        cors,
      );
    } catch (err) {
      const n = normalizeError(err);
      await admin
        .from("site_audit_runs")
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

function pageToRow(runId: string, siteId: string, p: PageRecord) {
  const d = p.data;
  return {
    run_id: runId,
    site_id: siteId,
    url: p.url,
    status_code: p.statusCode,
    is_redirect: p.isRedirect,
    redirect_target: p.redirectTarget,
    canonical_url: d?.canonicalUrl ?? null,
    is_self_canonical: d
      ? d.canonicalUrl == null || d.canonicalUrl === p.url
      : null,
    meta_robots_noindex: d?.metaRobotsNoindex ?? false,
    title: d?.title ?? null,
    title_length: d?.title?.length ?? null,
    meta_description: d?.metaDescription ?? null,
    meta_description_length: d?.metaDescription?.length ?? null,
    h1_count: d?.h1Count ?? null,
    h2_count: d?.h2Count ?? null,
    word_count: d?.wordCount ?? null,
    internal_link_count: d?.internalLinks.length ?? null,
    external_link_count: d?.externalLinkCount ?? null,
    images_total: d?.imagesTotal ?? null,
    images_missing_alt: d?.imagesMissingAlt ?? null,
    has_schema: d?.hasSchema ?? false,
    has_viewport_meta: d?.hasViewportMeta ?? false,
    has_opengraph: d?.hasOpenGraph ?? false,
    has_hreflang: d?.hasHreflang ?? false,
    has_pagination: d?.hasPagination ?? false,
    content_hash: d?.contentHash ?? null,
    crawl_depth: p.crawlDepth,
    discovered_from: p.discoveredFrom,
    response_time_ms: p.responseTimeMs,
  };
}

async function runCrawl(
  origin: string,
  homepageUrl: string,
): Promise<{ pages: PageRecord[]; issues: Issue[] }> {
  const startedAt = Date.now();
  const robots = await fetchRobots(origin);
  const sitemapUrls = await fetchSitemapUrls(origin, robots.sitemaps);

  const visited = new Set<string>();
  const linkedFrom = new Set<string>();
  const referrerCount = new Map<string, number>();
  const pages: PageRecord[] = [];
  const redirectHops = new Map<string, number>();
  const redirectLoops = new Set<string>();

  const queue: { url: string; depth: number }[] = [
    { url: homepageUrl, depth: 0 },
  ];
  visited.add(homepageUrl);

  function timeLeft(): boolean {
    return Date.now() - startedAt < TIME_BUDGET_MS && pages.length < MAX_PAGES;
  }

  async function worker() {
    for (;;) {
      if (!timeLeft()) return;
      const item = queue.shift();
      if (!item) return;
      const { url, depth } = item;
      const path = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return "/";
        }
      })();
      if (isDisallowed(path, robots.disallow)) continue;

      const fetched = await fetchOnePage(url);

      if (fetched.isRedirect && fetched.redirectTarget) {
        const target = resolveLink(fetched.redirectTarget, url);
        const hops = (redirectHops.get(url) ?? 0) + 1;
        if (target && target.origin === origin) {
          if (hops > MAX_REDIRECT_HOPS) {
            redirectLoops.add(url);
          } else {
            redirectHops.set(target.toString(), hops);
            if (
              !visited.has(target.toString()) &&
              pages.length + queue.length < MAX_PAGES
            ) {
              visited.add(target.toString());
              queue.push({ url: target.toString(), depth });
            }
          }
        }
      }

      const data = fetched.html ? extractPageData(fetched.html, url) : null;
      if (data) {
        for (const link of data.internalLinks) {
          linkedFrom.add(link);
          referrerCount.set(link, (referrerCount.get(link) ?? 0) + 1);
          if (
            !visited.has(link) &&
            depth + 1 <= MAX_DEPTH &&
            pages.length + queue.length < MAX_PAGES
          ) {
            visited.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }

      pages.push({
        url,
        statusCode: fetched.statusCode,
        isRedirect: fetched.isRedirect,
        redirectTarget: fetched.redirectTarget
          ? (resolveLink(fetched.redirectTarget, url)?.toString() ??
            fetched.redirectTarget)
          : null,
        crawlDepth: depth,
        discoveredFrom: "crawl",
        data,
        responseTimeMs: fetched.responseTimeMs,
      });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Sitemap URLs the crawl never reached, within whatever page budget is
  // left - lets orphan/sitemap-inconsistency checks see them too.
  const remaining = MAX_PAGES - pages.length;
  if (remaining > 0 && timeLeft()) {
    const unreached = [...sitemapUrls]
      .filter((u) => !visited.has(u))
      .slice(0, remaining);
    async function sitemapWorker() {
      for (;;) {
        if (!timeLeft()) return;
        const url = unreached.shift();
        if (!url) return;
        let sameOrigin = false;
        try {
          sameOrigin = new URL(url).origin === origin;
        } catch {
          continue;
        }
        if (!sameOrigin) continue;
        const fetched = await fetchOnePage(url);
        const data = fetched.html ? extractPageData(fetched.html, url) : null;
        pages.push({
          url,
          statusCode: fetched.statusCode,
          isRedirect: fetched.isRedirect,
          redirectTarget: fetched.redirectTarget,
          crawlDepth: -1,
          discoveredFrom: "sitemap",
          data,
          responseTimeMs: fetched.responseTimeMs,
        });
      }
    }
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => sitemapWorker()),
    );
  }

  const issues = computeIssues(
    pages,
    sitemapUrls,
    linkedFrom,
    referrerCount,
    redirectLoops,
    startedAt,
  );
  return { pages, issues };
}

function computeIssues(
  pages: PageRecord[],
  sitemapUrls: Set<string>,
  linkedFrom: Set<string>,
  referrerCount: Map<string, number>,
  redirectLoops: Set<string>,
  startedAt: number,
): Issue[] {
  const issues: Issue[] = [];
  const byTitle = new Map<string, string[]>();
  const byDescription = new Map<string, string[]>();
  const byContentHash = new Map<string, string[]>();
  let schemaPages = 0;

  for (const p of pages) {
    const d = p.data;
    if (p.statusCode != null && p.statusCode >= 500) {
      issues.push({
        url: p.url,
        severity: "error",
        category: "response",
        code: "server_error",
        message: `Server returned HTTP ${p.statusCode}.`,
      });
    } else if (p.statusCode != null && p.statusCode >= 400) {
      const referrers = referrerCount.get(p.url) ?? 0;
      issues.push({
        url: p.url,
        severity: "error",
        category: "broken-links",
        code: "broken_page",
        message: `Broken page (HTTP ${p.statusCode})${referrers > 0 ? `, linked from ${referrers} crawled page(s)` : ""}.`,
      });
    } else if (p.statusCode == null) {
      issues.push({
        url: p.url,
        severity: "error",
        category: "response",
        code: "fetch_failed",
        message: "Could not fetch this URL (timeout or network error).",
      });
    }

    if (p.isRedirect) {
      const isLoop = redirectLoops.has(p.url);
      issues.push({
        url: p.url,
        severity: isLoop ? "error" : "notice",
        category: "redirects",
        code: isLoop ? "redirect_loop" : "redirect",
        message: isLoop
          ? `Redirect chain exceeded ${MAX_REDIRECT_HOPS} hops - likely a redirect loop.`
          : `Redirects (HTTP ${p.statusCode}) to ${p.redirectTarget ?? "an unknown location"}.`,
      });
    }

    if (
      p.discoveredFrom === "sitemap" &&
      p.statusCode != null &&
      p.statusCode >= 400
    ) {
      issues.push({
        url: p.url,
        severity: "error",
        category: "sitemap",
        code: "sitemap_broken_url",
        message: "This URL is listed in the sitemap but returns an error.",
      });
    }

    if (!d) continue;

    if (sitemapUrls.has(p.url) && d.metaRobotsNoindex) {
      issues.push({
        url: p.url,
        severity: "warning",
        category: "sitemap",
        code: "noindex_in_sitemap",
        message: "This page is noindex but is still listed in the sitemap.",
      });
    }

    if (!d.canonicalUrl) {
      issues.push({
        url: p.url,
        severity: "notice",
        category: "canonical",
        code: "missing_canonical",
        message: "No canonical tag found.",
      });
    } else if (d.canonicalUrl !== p.url) {
      issues.push({
        url: p.url,
        severity: "notice",
        category: "canonical",
        code: "non_self_canonical",
        message: `Canonical points to a different URL: ${d.canonicalUrl}.`,
      });
    }

    if (!d.title) {
      issues.push({
        url: p.url,
        severity: "error",
        category: "titles",
        code: "missing_title",
        message: "No <title> tag found.",
      });
    } else {
      if (d.title.length < 10 || d.title.length > 65) {
        issues.push({
          url: p.url,
          severity: "notice",
          category: "titles",
          code: "title_length",
          message: `Title is ${d.title.length} characters (recommended 10-65).`,
        });
      }
      const list = byTitle.get(d.title) ?? [];
      list.push(p.url);
      byTitle.set(d.title, list);
    }

    if (!d.metaDescription) {
      issues.push({
        url: p.url,
        severity: "warning",
        category: "meta-description",
        code: "missing_meta_description",
        message: "No meta description found.",
      });
    } else {
      const list = byDescription.get(d.metaDescription) ?? [];
      list.push(p.url);
      byDescription.set(d.metaDescription, list);
    }

    if (d.h1Count === 0) {
      issues.push({
        url: p.url,
        severity: "warning",
        category: "headings",
        code: "missing_h1",
        message: "No H1 heading found.",
      });
    } else if (d.h1Count > 1) {
      issues.push({
        url: p.url,
        severity: "notice",
        category: "headings",
        code: "multiple_h1",
        message: `${d.h1Count} H1 headings found (expected 1).`,
      });
    }

    if (d.wordCount < THIN_CONTENT_WORD_THRESHOLD) {
      issues.push({
        url: p.url,
        severity: "notice",
        category: "content",
        code: "thin_content",
        message: `Only ${d.wordCount} words of visible text detected.`,
      });
    }

    if (d.imagesMissingAlt > 0) {
      issues.push({
        url: p.url,
        severity: d.imagesMissingAlt > d.imagesTotal / 2 ? "warning" : "notice",
        category: "images",
        code: "images_missing_alt",
        message: `${d.imagesMissingAlt} of ${d.imagesTotal} images are missing alt text.`,
      });
    }

    if (!d.hasViewportMeta) {
      issues.push({
        url: p.url,
        severity: "warning",
        category: "mobile",
        code: "missing_viewport",
        message: "No mobile viewport meta tag found.",
      });
    }

    if (d.hasSchema) schemaPages += 1;

    const hashList = byContentHash.get(d.contentHash) ?? [];
    hashList.push(p.url);
    byContentHash.set(d.contentHash, hashList);

    if (
      p.discoveredFrom === "sitemap" &&
      p.crawlDepth === -1 &&
      !linkedFrom.has(p.url)
    ) {
      issues.push({
        url: p.url,
        severity: "notice",
        category: "orphan-pages",
        code: "orphan_page",
        message: "In the sitemap but not linked from any crawled page.",
      });
    }

    if (p.crawlDepth > 4) {
      issues.push({
        url: p.url,
        severity: "notice",
        category: "crawl-depth",
        code: "deep_page",
        message: `${p.crawlDepth} clicks from the homepage.`,
      });
    }
  }

  for (const [title, urls] of byTitle) {
    if (urls.length > 1) {
      for (const url of urls) {
        issues.push({
          url,
          severity: "warning",
          category: "titles",
          code: "duplicate_title",
          message: `Duplicate title "${title}" shared with ${urls.length - 1} other page(s).`,
        });
      }
    }
  }
  for (const [, urls] of byDescription) {
    if (urls.length > 1) {
      for (const url of urls) {
        issues.push({
          url,
          severity: "warning",
          category: "meta-description",
          code: "duplicate_meta_description",
          message: `Duplicate meta description shared with ${urls.length - 1} other page(s).`,
        });
      }
    }
  }
  for (const [, urls] of byContentHash) {
    if (urls.length > 1) {
      for (const url of urls) {
        issues.push({
          url,
          severity: "warning",
          category: "duplicate-content",
          code: "duplicate_content",
          message: `Near-identical extracted text shared with ${urls.length - 1} other page(s).`,
        });
      }
    }
  }

  const pagesWithData = pages.filter((p) => p.data).length;
  if (pagesWithData > 0 && schemaPages === 0) {
    issues.push({
      url: null,
      severity: "notice",
      category: "schema",
      code: "no_schema_sitewide",
      message: "No page in this crawl had schema.org/JSON-LD structured data.",
    });
  }

  if (Date.now() - startedAt >= TIME_BUDGET_MS || pages.length >= MAX_PAGES) {
    issues.push({
      url: null,
      severity: "notice",
      category: "coverage",
      code: "crawl_budget_reached",
      message: `Crawl stopped at ${pages.length} page(s) due to the time/page budget - coverage may be partial.`,
    });
  }

  return issues;
}
