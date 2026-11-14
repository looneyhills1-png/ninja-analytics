// Pure AI-readiness checks for owned sites. No Deno/npm imports so Vitest can
// exercise it; the Edge Function does the (bounded, rate-limited) fetching.

import {
  extractPageData,
  THIN_CONTENT_WORD_THRESHOLD,
} from "./site-crawler.ts";

export type Severity = "error" | "warning" | "notice" | "ok";

export interface Finding {
  checkKey: string;
  severity: Severity;
  url: string | null;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface CrawlerSpec {
  name: string;
  /** Lower-case token matched against robots.txt User-agent lines. */
  token: string;
  /** search = fetches pages to cite them in answers/results; training = model
   * training opt-out control. Blocking a search bot hurts discoverability;
   * blocking a training bot is a legitimate owner choice. */
  role: "search" | "training";
}

export const CRAWLERS: CrawlerSpec[] = [
  { name: "Googlebot", token: "googlebot", role: "search" },
  { name: "Bingbot", token: "bingbot", role: "search" },
  { name: "OAI-SearchBot", token: "oai-searchbot", role: "search" },
  { name: "ChatGPT-User", token: "chatgpt-user", role: "search" },
  { name: "PerplexityBot", token: "perplexitybot", role: "search" },
  { name: "Claude-SearchBot", token: "claude-searchbot", role: "search" },
  { name: "GPTBot", token: "gptbot", role: "training" },
  { name: "ClaudeBot", token: "claudebot", role: "training" },
  { name: "Google-Extended", token: "google-extended", role: "training" },
  { name: "Applebot-Extended", token: "applebot-extended", role: "training" },
];

interface RobotsRule {
  allow: boolean;
  path: string;
}
interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export function parseRobotsGroups(text: string): {
  groups: RobotsGroup[];
  sitemaps: string[];
} {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return { groups, sitemaps };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** RFC 9309 matching: the most specific group for the agent (falling back to
 * `*`), longest matching rule wins, Allow wins a tie, no match = allowed. */
export function robotsAllows(
  groups: RobotsGroup[],
  agentToken: string,
  path: string,
): boolean {
  const token = agentToken.toLowerCase();
  let rules: RobotsRule[] | null = null;
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && token.includes(a)),
  );
  if (specific.length) {
    rules = specific.flatMap((g) => g.rules);
  } else {
    const star = groups.filter((g) => g.agents.includes("*"));
    if (star.length) rules = star.flatMap((g) => g.rules);
  }
  if (!rules) return true;

  let best: { len: number; allow: boolean } | null = null;
  for (const r of rules) {
    if (r.path === "") continue; // empty Disallow/Allow matches nothing
    if (!patternToRegex(r.path).test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) {
      best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

export function evaluateRobots(
  robotsText: string | null,
  status: number | null,
  origin: string,
): { findings: Finding[]; sitemaps: string[] } {
  const url = `${origin}/robots.txt`;
  if (status === null || robotsText === null) {
    return {
      findings: [
        {
          checkKey: "robots_fetch",
          severity: "warning",
          url,
          message:
            "robots.txt could not be fetched (network error or timeout).",
        },
      ],
      sitemaps: [],
    };
  }
  if (status === 404 || status === 410) {
    return {
      findings: [
        {
          checkKey: "robots_missing",
          severity: "notice",
          url,
          message:
            "No robots.txt (404). All crawlers are allowed by default, but a sitemap reference cannot be declared.",
          evidence: { status },
        },
      ],
      sitemaps: [],
    };
  }
  if (status >= 400) {
    return {
      findings: [
        {
          checkKey: "robots_error",
          severity: status >= 500 ? "error" : "warning",
          url,
          message: `robots.txt returned HTTP ${status}. Crawlers may treat the whole site as unavailable.`,
          evidence: { status },
        },
      ],
      sitemaps: [],
    };
  }

  const { groups, sitemaps } = parseRobotsGroups(robotsText);
  const findings: Finding[] = [];
  for (const c of CRAWLERS) {
    const allowed = robotsAllows(groups, c.token, "/");
    if (allowed) {
      findings.push({
        checkKey: `crawler_${c.token}`,
        severity: "ok",
        url,
        message: `${c.name} may crawl the site root.`,
        evidence: { crawler: c.name, role: c.role },
      });
    } else if (c.role === "search") {
      findings.push({
        checkKey: `crawler_${c.token}`,
        severity: "error",
        url,
        message: `${c.name} is blocked by robots.txt. Content cannot be fetched for search/answer results from this crawler.`,
        evidence: { crawler: c.name, role: c.role },
      });
    } else {
      findings.push({
        checkKey: `crawler_${c.token}`,
        severity: "notice",
        url,
        message: `${c.name} (model-training control) is blocked. This is an owner choice and does not affect search visibility.`,
        evidence: { crawler: c.name, role: c.role },
      });
    }
  }
  if (sitemaps.length === 0) {
    findings.push({
      checkKey: "robots_no_sitemap",
      severity: "notice",
      url,
      message: "robots.txt does not declare a Sitemap.",
    });
  }
  return { findings, sitemaps };
}

// -- Structured data ---------------------------------------------------------

const JSONLD_RE =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export interface StructuredDataResult {
  blocks: number;
  invalid: number;
  types: string[];
}

export function inspectStructuredData(html: string): StructuredDataResult {
  const types = new Set<string>();
  let blocks = 0;
  let invalid = 0;
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      const t = o["@type"];
      if (typeof t === "string") types.add(t);
      else if (Array.isArray(t)) {
        t.forEach((x) => typeof x === "string" && types.add(x));
      }
      if (o["@graph"]) collect(o["@graph"]);
    }
  };
  for (const m of html.matchAll(JSONLD_RE)) {
    blocks += 1;
    try {
      collect(JSON.parse(m[1].trim()));
    } catch {
      invalid += 1;
    }
  }
  return { blocks, invalid, types: [...types] };
}

// -- Per-page checks ---------------------------------------------------------

const QUESTION_START =
  /^(what|why|how|when|where|who|which|can|do|does|is|are|should|will)\b/i;

export function countAnswerHeadings(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    const text = m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.endsWith("?") || QUESTION_START.test(text)) n += 1;
  }
  return n;
}

export interface PageInput {
  url: string;
  status: number | null;
  /** Final URL after redirects, if different. */
  finalUrl?: string | null;
  redirectHops?: number;
  xRobotsTag?: string | null;
  html: string | null;
}

export function evaluatePage(page: PageInput): Finding[] {
  const out: Finding[] = [];
  const { url } = page;

  if (page.status === null) {
    return [
      {
        checkKey: "page_unreachable",
        severity: "error",
        url,
        message: "Page could not be fetched (network error or timeout).",
      },
    ];
  }
  if (page.status >= 400) {
    return [
      {
        checkKey: "page_http_error",
        severity: "error",
        url,
        message: `Page returned HTTP ${page.status}.`,
        evidence: { status: page.status },
      },
    ];
  }
  if ((page.redirectHops ?? 0) > 1) {
    out.push({
      checkKey: "redirect_chain",
      severity: "warning",
      url,
      message: `Redirect chain of ${page.redirectHops} hops before the final page.`,
      evidence: { hops: page.redirectHops, finalUrl: page.finalUrl ?? null },
    });
  }
  if (page.xRobotsTag && /noindex/i.test(page.xRobotsTag)) {
    out.push({
      checkKey: "noindex_header",
      severity: "error",
      url,
      message: "X-Robots-Tag header contains noindex.",
      evidence: { header: page.xRobotsTag },
    });
  }
  if (!page.html) return out;

  const data = extractPageData(page.html, page.finalUrl ?? url);
  if (data.metaRobotsNoindex) {
    out.push({
      checkKey: "noindex_meta",
      severity: "error",
      url,
      message:
        "Meta robots tag contains noindex; the page will not be indexed.",
    });
  }
  if (!data.canonicalUrl) {
    out.push({
      checkKey: "canonical_missing",
      severity: "warning",
      url,
      message: "No canonical URL declared.",
    });
  } else {
    try {
      const canon = new URL(data.canonicalUrl, url);
      const self = new URL(page.finalUrl ?? url);
      if (canon.host !== self.host) {
        out.push({
          checkKey: "canonical_offsite",
          severity: "warning",
          url,
          message: `Canonical points to a different host (${canon.host}).`,
          evidence: { canonical: canon.href },
        });
      }
    } catch {
      out.push({
        checkKey: "canonical_invalid",
        severity: "warning",
        url,
        message: "Canonical URL is not a valid URL.",
        evidence: { canonical: data.canonicalUrl },
      });
    }
  }

  const sd = inspectStructuredData(page.html);
  if (sd.invalid > 0) {
    out.push({
      checkKey: "structured_data_invalid",
      severity: "error",
      url,
      message: `${sd.invalid} of ${sd.blocks} JSON-LD block(s) are not valid JSON.`,
      evidence: { blocks: sd.blocks, invalid: sd.invalid },
    });
  } else if (sd.blocks === 0) {
    out.push({
      checkKey: "structured_data_missing",
      severity: "notice",
      url,
      message: "No JSON-LD structured data found.",
    });
  }

  if (!data.title) {
    out.push({
      checkKey: "title_missing",
      severity: "warning",
      url,
      message: "Missing <title>.",
    });
  }
  if (data.h1Count === 0) {
    out.push({
      checkKey: "h1_missing",
      severity: "warning",
      url,
      message: "No H1 heading.",
    });
  }
  if (data.wordCount < THIN_CONTENT_WORD_THRESHOLD) {
    out.push({
      checkKey: "thin_content",
      severity: "notice",
      url,
      message: `Only ${data.wordCount} words of body text (threshold ${THIN_CONTENT_WORD_THRESHOLD}).`,
      evidence: { words: data.wordCount },
    });
  } else if (data.h2Count > 0 && countAnswerHeadings(page.html) === 0) {
    out.push({
      checkKey: "no_answer_headings",
      severity: "notice",
      url,
      message:
        "No question-style or answer-focused H2/H3 headings. Heuristic only; not every page needs them.",
      evidence: { h2: data.h2Count },
    });
  }
  return out;
}

/** Duplicate-content findings across the pages of one run (same hash). */
export function findDuplicates(
  pages: Array<{ url: string; contentHash: string; wordCount: number }>,
): Finding[] {
  const byHash = new Map<string, string[]>();
  for (const p of pages) {
    if (p.wordCount < THIN_CONTENT_WORD_THRESHOLD) continue;
    byHash.set(p.contentHash, [...(byHash.get(p.contentHash) ?? []), p.url]);
  }
  const out: Finding[] = [];
  for (const urls of byHash.values()) {
    if (urls.length < 2) continue;
    for (const u of urls) {
      out.push({
        checkKey: "duplicate_content",
        severity: "warning",
        url: u,
        message: `Identical body text to ${urls.length - 1} other page(s) in this scan.`,
        evidence: { duplicates: urls.filter((x) => x !== u).slice(0, 5) },
      });
    }
  }
  return out;
}

/** The scan only ever touches the site's own host. */
export function isOwnedUrl(candidate: string, domain: string): boolean {
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    const d = domain.toLowerCase().replace(/^www\./, "");
    return host === d || host === `www.${d}`;
  } catch {
    return false;
  }
}
