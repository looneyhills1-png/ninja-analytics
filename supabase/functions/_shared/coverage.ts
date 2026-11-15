// Full-site URL coverage logic. Pure and deterministic (no network, no AI) so
// discovery, de-duplication, queueing, status classification and diagnosis can
// be unit tested. The edge function coverage-sync does the fetching.
//
// Two kinds of fact are kept apart on purpose:
//   * LIVE facts: what Ninja Analytics itself saw when it requested the URL.
//   * GOOGLE facts: what the Search Console URL Inspection API reported.
// Neither is ever used to guess the other, and a site-wide indexed total is
// only reported when every eligible URL has actually been inspected.

export const LIMITS = {
  /** Sitemaps read per site per run (index children included). */
  maxSitemaps: 12,
  /** URLs accepted from sitemaps per site per run. */
  maxSitemapUrls: 2000,
  /** Distinct Search Console pages considered per site per run. */
  maxGscPages: 2000,
  /** URLs the inventory will hold per site. */
  maxInventory: 5000,
  /** Live page checks per site per run (politely paced). */
  liveBatch: 30,
  /** Google URL Inspection calls per site per run. The API allows 2,000 a
   * day per property; this stays far below it. */
  inspectBatch: 30,
  /** A URL is re-checked / re-inspected after this many days. */
  staleDays: 7,
  /** Wall-clock budget for one invocation, in milliseconds. */
  budgetMs: 100_000,
  /** Maximum internal links harvested from one page. */
  maxLinksPerPage: 200,
};

const ASSET_EXT =
  /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|mp4|mp3|woff2?|ttf|eot|map|rss|atom)$/i;

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|ref|mc_[a-z]+)$/i;

/** Absolute http(s) URL on a canonical footing, or null when unusable. The
 * fragment and tracking parameters are dropped; the path is left exactly as
 * given (a trailing slash or index.html is a real difference). */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  }
  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  ) {
    u.port = "";
  }
  return u.toString();
}

/** The hosts that count as "this website": its own host with and without
 * www. Anything else is another site and is never crawled or inspected. */
export function allowedHosts(websiteUrl: string, domain: string): Set<string> {
  const hosts = new Set<string>();
  const add = (h: string) => {
    const host = h.toLowerCase().replace(/^www\./, "");
    if (!host) return;
    hosts.add(host);
    hosts.add(`www.${host}`);
  };
  try {
    add(new URL(websiteUrl).hostname);
  } catch {
    // fall through to the domain
  }
  add(domain);
  return hosts;
}

export function sameHost(url: string, hosts: Set<string>): boolean {
  try {
    return hosts.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAssetUrl(url: string): boolean {
  try {
    return ASSET_EXT.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

/** /page/index.html -> /page/ ; null when the URL is not such an alias. */
export function indexHtmlTarget(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith("/index.html")) return null;
    u.pathname = u.pathname.slice(0, -"index.html".length);
    return u.toString();
  } catch {
    return null;
  }
}

export type Source =
  | "sitemap"
  | "internal_link"
  | "gsc"
  | "audit"
  | "inspection";

export interface InventoryRow {
  url: string;
  sources: Source[];
  inSitemap: boolean;
  isAlias: boolean;
  canonicalGroup: string | null;
  liveCheckedAt: string | null;
  liveStatus: number | null;
  liveRedirectTo: string | null;
  liveCanonical: string | null;
  liveNoindex: boolean | null;
  liveWordCount: number | null;
  liveTitle?: string | null;
  liveError: string | null;
  robotsAllowed: boolean | null;
}

export interface Discovered {
  url: string;
  source: Source;
}

/** Merges newly discovered URLs into an existing inventory (keyed by URL),
 * unions the sources, applies the host filter and the inventory cap, and
 * flags /index.html aliases. Never removes a URL: a page that disappears from
 * every source simply stops being refreshed. */
export function mergeInventory(
  existing: InventoryRow[],
  found: Discovered[],
  hosts: Set<string>,
  cap = LIMITS.maxInventory,
): { rows: InventoryRow[]; added: number; rejected: number } {
  const map = new Map(
    existing.map((r) => [r.url, { ...r, sources: [...r.sources] }]),
  );
  let added = 0;
  let rejected = 0;
  for (const f of found) {
    const url = normalizeUrl(f.url);
    if (!url || !sameHost(url, hosts) || isAssetUrl(url)) {
      rejected += 1;
      continue;
    }
    let row = map.get(url);
    if (!row) {
      if (map.size >= cap) {
        rejected += 1;
        continue;
      }
      const target = indexHtmlTarget(url);
      row = {
        url,
        sources: [],
        inSitemap: false,
        isAlias: target !== null,
        canonicalGroup: target,
        liveCheckedAt: null,
        liveStatus: null,
        liveRedirectTo: null,
        liveCanonical: null,
        liveNoindex: null,
        liveWordCount: null,
        liveError: null,
        robotsAllowed: null,
      };
      map.set(url, row);
      added += 1;
    }
    if (!row.sources.includes(f.source)) row.sources.push(f.source);
    if (f.source === "sitemap") row.inSitemap = true;
  }
  return { rows: [...map.values()], added, rejected };
}

/** After a live check: a page whose canonical differs from itself consolidates
 * into that canonical and is treated as an alias. */
export function applyLiveCanonical(row: InventoryRow): InventoryRow {
  if (!row.liveCanonical) return row;
  const canon = normalizeUrl(row.liveCanonical) ?? row.liveCanonical;
  // A canonical that names a different URL consolidates this page into it; a
  // self-canonical page is its own master even if its name ends in index.html.
  return canon !== row.url
    ? { ...row, isAlias: true, canonicalGroup: canon }
    : { ...row, isAlias: false, canonicalGroup: row.url };
}

// ---------------------------------------------------------------------------
// Queues (finite, incremental)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function age(iso: string | null | undefined, now: Date): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : (now.getTime() - t) / DAY;
}

/** Priority: sitemap + Search Console pages first (they matter most), then
 * internal links, aliases last. Within a tier, never-checked before stale. */
function tier(r: InventoryRow): number {
  if (r.isAlias) return 3;
  if (r.inSitemap || r.sources.includes("gsc")) return 0;
  if (r.sources.includes("internal_link")) return 1;
  return 2;
}

export function liveQueue(
  rows: InventoryRow[],
  now: Date,
  budget = LIMITS.liveBatch,
  staleDays = LIMITS.staleDays,
): string[] {
  return rows
    .filter((r) => age(r.liveCheckedAt, now) >= staleDays)
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        age(b.liveCheckedAt, now) - age(a.liveCheckedAt, now) ||
        a.url.localeCompare(b.url),
    )
    .slice(0, budget)
    .map((r) => r.url);
}

export function inspectionQueue(
  rows: InventoryRow[],
  lastInspected: Map<string, string>,
  now: Date,
  budget = LIMITS.inspectBatch,
  staleDays = LIMITS.staleDays,
): string[] {
  return rows
    .filter((r) => age(lastInspected.get(r.url), now) >= staleDays)
    .sort((a, b) => {
      const an = lastInspected.has(a.url) ? 1 : 0;
      const bn = lastInspected.has(b.url) ? 1 : 0;
      return (
        an - bn || // never inspected first
        tier(a) - tier(b) ||
        age(lastInspected.get(b.url), now) -
          age(lastInspected.get(a.url), now) ||
        a.url.localeCompare(b.url)
      );
    })
    .slice(0, budget)
    .map((r) => r.url);
}

// ---------------------------------------------------------------------------
// Live check classification
// ---------------------------------------------------------------------------

export interface LiveProbe {
  status: number | null;
  location: string | null;
  xRobotsTag: string | null;
  error: string | null;
}

export type LiveVerdict =
  | "ok"
  | "redirect"
  | "not_found"
  | "client_error"
  | "server_error"
  | "unreachable";

export function classifyLive(p: LiveProbe): LiveVerdict {
  if (p.error || p.status === null) return "unreachable";
  if (p.status >= 300 && p.status < 400) return "redirect";
  if (p.status === 404 || p.status === 410) return "not_found";
  if (p.status >= 400 && p.status < 500) return "client_error";
  if (p.status >= 500) return "server_error";
  return "ok";
}

/** noindex from the X-Robots-Tag header (a robots meta tag is read from the
 * HTML separately). */
export function headerNoindex(xRobotsTag: string | null): boolean {
  return !!xRobotsTag && /(^|[\s,])(noindex|none)([\s,]|$)/i.test(xRobotsTag);
}

// ---------------------------------------------------------------------------
// Google-reported status (verbatim buckets from url_inspections.ninja_status)
// ---------------------------------------------------------------------------

export interface InspectionFact {
  ninjaStatus: string;
  coverageState: string | null;
  lastCrawlTime: string | null;
  lastInspectedAt: string;
  googleCanonical?: string | null;
  userCanonical?: string | null;
}

export interface CoverageSummary {
  discovered: number;
  eligible: number;
  liveChecked: number;
  inspected: number;
  /** Counted among INSPECTED URLs only. */
  indexedAmongInspected: number;
  excludedAmongInspected: number;
  unknownAmongInspected: number;
  /** Site-wide totals are null (UNKNOWN) until every eligible URL has been
   * inspected. A sample is never extrapolated. */
  indexedTotal: number | null;
  excludedTotal: number | null;
  complete: boolean;
  excludedByReason: Array<{ reason: string; count: number; urls: string[] }>;
  technicalErrors: Array<{ url: string; problem: string }>;
}

const EXCLUDED = new Set([
  "not_indexed",
  "crawled_not_indexed",
  "discovered_not_indexed",
  "canonical_mismatch",
  "blocked",
]);

export function summariseCoverage(
  rows: InventoryRow[],
  inspections: Map<string, InspectionFact>,
): CoverageSummary {
  const eligible = rows.filter((r) => !isAssetUrl(r.url));
  const inspectedRows = eligible.filter((r) => inspections.has(r.url));
  let indexed = 0;
  let excluded = 0;
  let unknown = 0;
  const reasons = new Map<string, string[]>();
  for (const r of inspectedRows) {
    const i = inspections.get(r.url)!;
    if (i.ninjaStatus === "indexed") indexed += 1;
    else if (EXCLUDED.has(i.ninjaStatus)) {
      excluded += 1;
      const reason = i.coverageState || i.ninjaStatus.replace(/_/g, " ");
      reasons.set(reason, [...(reasons.get(reason) ?? []), r.url]);
    } else unknown += 1;
  }
  const errors: Array<{ url: string; problem: string }> = [];
  for (const r of eligible) {
    if (r.liveStatus === null) continue;
    const v = classifyLive({
      status: r.liveStatus,
      location: r.liveRedirectTo,
      xRobotsTag: null,
      error: r.liveError,
    });
    if (v === "not_found" && r.inSitemap) {
      errors.push({ url: r.url, problem: "In the sitemap but returns 404" });
    } else if (v === "server_error") {
      errors.push({ url: r.url, problem: `Server error ${r.liveStatus}` });
    } else if (v === "client_error") {
      errors.push({
        url: r.url,
        problem: `Returns ${r.liveStatus} to our request`,
      });
    } else if (v === "unreachable") {
      errors.push({ url: r.url, problem: r.liveError ?? "Unreachable" });
    }
  }
  const complete =
    eligible.length > 0 && inspectedRows.length === eligible.length;
  return {
    discovered: rows.length,
    eligible: eligible.length,
    liveChecked: eligible.filter((r) => r.liveCheckedAt).length,
    inspected: inspectedRows.length,
    indexedAmongInspected: indexed,
    excludedAmongInspected: excluded,
    unknownAmongInspected: unknown,
    indexedTotal: complete ? indexed : null,
    excludedTotal: complete ? excluded : null,
    complete,
    excludedByReason: [...reasons.entries()]
      .map(([reason, urls]) => ({
        reason,
        count: urls.length,
        urls: urls.slice(0, 20),
      }))
      .sort((a, b) => b.count - a.count),
    technicalErrors: errors,
  };
}

// ---------------------------------------------------------------------------
// Per-URL diagnosis: should this URL be indexed, and what to do about it
// ---------------------------------------------------------------------------

export interface Diagnosis {
  url: string;
  shouldBeIndexed: "yes" | "no" | "unclear";
  /** Plain-English reason, grounded only in the evidence listed. */
  reason: string;
  evidence: string[];
  action: string;
  /** Ranking-sensitive actions always need the owner's approval. */
  needsApproval: boolean;
  category:
    | "healthy"
    | "alias"
    | "redirect"
    | "not_found"
    | "noindex"
    | "blocked"
    | "content"
    | "waiting"
    | "undiscovered"
    | "unknown";
}

const THIN_WORDS = 250;

export function diagnoseUrl(
  row: InventoryRow,
  insp: InspectionFact | undefined,
): Diagnosis {
  const ev: string[] = [];
  if (insp) {
    ev.push(
      `Google: ${insp.coverageState ?? insp.ninjaStatus.replace(/_/g, " ")}` +
        (insp.lastCrawlTime
          ? ` (last crawled ${insp.lastCrawlTime.slice(0, 10)})`
          : ""),
    );
  } else ev.push("Google: not inspected yet");
  if (row.liveStatus !== null) {
    ev.push(
      `Live: HTTP ${row.liveStatus}` +
        (row.liveRedirectTo ? ` to ${row.liveRedirectTo}` : ""),
    );
  } else ev.push("Live: not checked yet");
  if (row.liveCanonical) ev.push(`Canonical tag: ${row.liveCanonical}`);
  ev.push(row.inSitemap ? "Listed in the sitemap" : "Not in the sitemap");
  if (row.liveWordCount !== null)
    ev.push(`${row.liveWordCount} words of content`);
  if (row.robotsAllowed === false)
    ev.push("robots.txt asks crawlers to skip it");

  const base = { url: row.url, evidence: ev };

  if (row.liveStatus === 404 || row.liveStatus === 410) {
    return {
      ...base,
      shouldBeIndexed: "no",
      category: "not_found",
      reason: "The page does not exist, so it should not be indexed.",
      action: row.inSitemap
        ? "Remove it from the sitemap and from any internal links. If the content moved, redirect it to the new page (needs your approval)."
        : "Remove any internal links to it. If the content moved, redirect it to the new page (needs your approval).",
      needsApproval: true,
    };
  }
  if (
    row.liveStatus !== null &&
    row.liveStatus >= 300 &&
    row.liveStatus < 400
  ) {
    return {
      ...base,
      shouldBeIndexed: "no",
      category: "redirect",
      reason:
        "The page redirects elsewhere, so Google correctly indexes the destination instead.",
      action: row.inSitemap
        ? "Replace this sitemap entry with the destination address, and point internal links at the destination."
        : "Nothing to fix if the redirect is intended; point internal links at the destination.",
      needsApproval: false,
    };
  }
  if (row.isAlias && row.canonicalGroup) {
    return {
      ...base,
      shouldBeIndexed: "no",
      category: "alias",
      reason: `This is an alternate address of ${row.canonicalGroup}. Its canonical tag tells Google to index that one instead.`,
      action:
        "Make the site's own links use the preferred address. No canonical or redirect change is needed.",
      needsApproval: true,
    };
  }
  if (row.liveNoindex) {
    return {
      ...base,
      shouldBeIndexed: "no",
      category: "noindex",
      reason: "The page asks search engines not to index it (noindex).",
      action: row.inSitemap
        ? "Remove it from the sitemap, or remove the noindex if it should be found in search."
        : "Nothing to fix if the noindex is intended.",
      needsApproval: true,
    };
  }
  if (
    row.liveStatus !== null &&
    row.liveStatus >= 400 &&
    row.liveStatus !== 404 &&
    row.liveStatus !== 410
  ) {
    return {
      ...base,
      shouldBeIndexed: "unclear",
      category: "blocked",
      reason: `The page answered our request with HTTP ${row.liveStatus}. Google may be getting the same refusal, but this check cannot prove what Googlebot receives.`,
      action:
        "Check that the host or firewall is not refusing crawlers for this address. If the page is intentionally restricted, remove it from the sitemap.",
      needsApproval: false,
    };
  }
  if (
    insp &&
    /unknown to google/i.test(insp.coverageState ?? "") &&
    row.liveStatus === 200 &&
    !row.liveNoindex &&
    row.robotsAllowed !== false
  ) {
    return {
      ...base,
      shouldBeIndexed: "yes",
      category: "undiscovered",
      reason:
        "Google has not discovered this page yet. It is live (HTTP 200), indexable and not blocked, so nothing on the page is stopping it.",
      action:
        "Make sure a page Google already indexes links to it, and re-read the sitemap in Search Console. This tool has read-only access, so asking Google to re-read the sitemap is an action for you in Search Console.",
      needsApproval: false,
    };
  }
  if (insp?.ninjaStatus === "indexed") {
    return {
      ...base,
      shouldBeIndexed: "yes",
      category: "healthy",
      reason: "Google reports the page as indexed.",
      action: "Nothing to fix.",
      needsApproval: false,
    };
  }
  if (insp?.ninjaStatus === "crawled_not_indexed") {
    const thin = row.liveWordCount !== null && row.liveWordCount < THIN_WORDS;
    return {
      ...base,
      shouldBeIndexed: "yes",
      category: "content",
      reason: thin
        ? `Google fetched the page but chose not to index it. It has little content (${row.liveWordCount} words), which is a common reason.`
        : "Google fetched the page but chose not to index it. The page itself is reachable and indexable, so the usual causes are content that is not distinctive enough or too few internal links to it.",
      action:
        "Add genuinely useful, original information and relevant links from stronger pages. Do not resubmit it repeatedly. This is a content change and needs your approval.",
      needsApproval: true,
    };
  }
  if (insp?.ninjaStatus === "discovered_not_indexed") {
    return {
      ...base,
      shouldBeIndexed: "yes",
      category: "waiting",
      reason: "Google knows the address but has not crawled it yet.",
      action:
        "Make sure it is linked from important pages. No other action is needed; check again next week.",
      needsApproval: false,
    };
  }
  if (insp && insp.ninjaStatus !== "indexed") {
    return {
      ...base,
      shouldBeIndexed: "unclear",
      category: "unknown",
      reason: `Google reports: ${insp.coverageState ?? insp.ninjaStatus.replace(/_/g, " ")}.`,
      action: "Open the Search Console inspection link for the detail.",
      needsApproval: false,
    };
  }
  return {
    ...base,
    shouldBeIndexed: "unclear",
    category: "unknown",
    reason:
      "Not enough information yet: the page has not been inspected by Google's tool.",
    action: "It is queued for inspection.",
    needsApproval: false,
  };
}
