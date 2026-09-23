// Pure HTML/robots/sitemap parsing for the Site Audit crawler (CLAUDE.md
// Phase 5). No Deno or npm imports, so this is unit-testable from Vitest -
// only the actual fetching lives in the site-audit-crawl Edge Function.
//
// Deliberately regex/string based rather than a full HTML parser dependency:
// good enough for the checks the brief asks for (title, meta description,
// canonical, robots meta, headings, links, images, schema presence) without
// adding an unfamiliar parsing library to a deploy-sensitive Edge Function.

export interface RobotsRules {
  disallow: string[];
  sitemaps: string[];
}

/** Parses only the `User-agent: *` block (and any rule with no preceding
 * User-agent, which applies to everyone) - good enough to avoid crawling
 * paths a site has asked every bot to skip. */
export function parseRobotsTxt(text: string): RobotsRules {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let inWildcardBlock = true; // rules before any User-agent line apply to all

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      inWildcardBlock = value === "*";
      continue;
    }
    if (key === "sitemap" && value) {
      sitemaps.push(value);
      continue;
    }
    if (key === "disallow" && inWildcardBlock && value) {
      disallow.push(value);
    }
  }
  return { disallow, sitemaps };
}

export function isDisallowed(path: string, disallow: string[]): boolean {
  return disallow.some((rule) => rule !== "" && path.startsWith(rule));
}

const SITEMAP_LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

/** Extracts every <loc> from a <urlset> or <sitemapindex> document - the
 * caller distinguishes which by whether the URLs look like nested sitemaps. */
export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(SITEMAP_LOC_RE);
  while ((match = re.exec(xml)) !== null) {
    out.push(match[1]);
  }
  return out;
}

export function isLikelySitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

const SITEMAP_URL_BLOCK_RE = /<url>([\s\S]*?)<\/url>/gi;
const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/i;
const LASTMOD_RE = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i;

/** Maps loc -> lastmod for every <url> entry that has both - the real,
 * first-party "when did our own build last touch this page" signal (Phase 4
 * indexing tracker's "material change since last Google crawl" detection).
 * A URL with no <lastmod> is simply absent from the map, never defaulted to
 * a guessed date. */
export function parseSitemapLastmods(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(SITEMAP_URL_BLOCK_RE);
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    const loc = LOC_RE.exec(block)?.[1];
    const lastmod = LASTMOD_RE.exec(block)?.[1];
    if (loc && lastmod) out.set(loc, lastmod);
  }
  return out;
}

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  metaRobotsNoindex: boolean;
  h1Count: number;
  h2Count: number;
  wordCount: number;
  contentHash: string;
  internalLinks: string[]; // absolute, same-origin, deduped
  externalLinkCount: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  hasSchema: boolean;
  hasViewportMeta: boolean;
  hasOpenGraph: boolean;
  hasHreflang: boolean;
  hasPagination: boolean;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Deterministic, non-cryptographic hash (FNV-1a) - only used to group pages
 * with identical extracted text, never for security. */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Resolves an href against a base URL; returns null for anything that isn't
 * a normal http(s) link worth following (mailto:, javascript:, #anchors…). */
export function resolveLink(href: string, baseUrl: string): URL | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(mailto|tel|javascript|data):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

const TAG_STRIP_RE = /<[^>]*>/g;
const SCRIPT_STYLE_RE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Extracts everything the audit checks need from one page's raw HTML. `html`
 * is expected already truncated to a sane byte budget by the caller - this
 * function does no I/O.
 */
export function extractPageData(html: string, pageUrl: string): ExtractedPage {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).trim() || null
    : null;

  const metaDescMatch =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i.exec(
      html,
    ) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i.exec(
      html,
    );
  const metaDescription = metaDescMatch
    ? decodeEntities(metaDescMatch[1]).trim() || null
    : null;

  const canonicalMatch =
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i.exec(
      html,
    ) ??
    /<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["'][^>]*>/i.exec(
      html,
    );
  let canonicalUrl: string | null = null;
  if (canonicalMatch) {
    const resolved = resolveLink(canonicalMatch[1], pageUrl);
    canonicalUrl = resolved ? resolved.toString() : null;
  }

  const robotsMetaMatch =
    /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i.exec(
      html,
    );
  const metaRobotsNoindex = robotsMetaMatch
    ? /noindex/i.test(robotsMetaMatch[1])
    : false;

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  const h2Count = (html.match(/<h2[\s>]/gi) ?? []).length;
  const hasSchema = /<script[^>]+type=["']application\/ld\+json["']/i.test(
    html,
  );
  const hasViewportMeta = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasOpenGraph = /<meta[^>]+property=["']og:[a-z:]+["']/i.test(html);
  const hasHreflang = /<link[^>]+rel=["']alternate["'][^>]+hreflang=/i.test(
    html,
  );
  const hasPagination = /<link[^>]+rel=["'](?:prev|next)["'][^>]*>/i.test(html);

  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const visibleHtml = bodyHtml.replace(SCRIPT_STYLE_RE, " ");
  const text = decodeEntities(visibleHtml.replace(TAG_STRIP_RE, " "))
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = text.length === 0 ? 0 : text.split(" ").length;
  const contentHash = fnv1aHash(text.toLowerCase());

  const origin = new URL(pageUrl).origin;
  const internalLinks = new Set<string>();
  let externalLinkCount = 0;
  const hrefRe = /<a\b[^>]*href=["']([^"']*)["'][^>]*>/gi;
  let hrefMatch: RegExpExecArray | null;
  while ((hrefMatch = hrefRe.exec(html)) !== null) {
    const resolved = resolveLink(hrefMatch[1], pageUrl);
    if (!resolved) continue;
    if (resolved.origin === origin) {
      internalLinks.add(resolved.toString());
    } else {
      externalLinkCount += 1;
    }
  }

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  const imgRe = /<img\b[^>]*>/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgRe.exec(html)) !== null) {
    imagesTotal += 1;
    const tag = imgMatch[0];
    const altMatch = /alt=["']([^"']*)["']/i.exec(tag);
    if (!altMatch || altMatch[1].trim().length === 0) imagesMissingAlt += 1;
  }

  return {
    title,
    metaDescription,
    canonicalUrl,
    metaRobotsNoindex,
    h1Count,
    h2Count,
    wordCount,
    contentHash,
    internalLinks: [...internalLinks],
    externalLinkCount,
    imagesTotal,
    imagesMissingAlt,
    hasSchema,
    hasViewportMeta,
    hasOpenGraph,
    hasHreflang,
    hasPagination,
  };
}

export const THIN_CONTENT_WORD_THRESHOLD = 150;
export const HEALTH_SCORE_WEIGHTS = { error: 4, warning: 2, notice: 0.5 };

/** Explainable 0-100 Health Score - a flat, fixed-weight deduction per issue
 * (never a vendor's proprietary "site health" metric), floored at 0. */
export function computeHealthScore(
  errors: number,
  warnings: number,
  notices: number,
): number {
  const deduction =
    errors * HEALTH_SCORE_WEIGHTS.error +
    warnings * HEALTH_SCORE_WEIGHTS.warning +
    notices * HEALTH_SCORE_WEIGHTS.notice;
  return Math.max(0, Math.min(100, Math.round(100 - deduction)));
}
