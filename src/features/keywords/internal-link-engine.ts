// Internal Link Engine (Phase 2) - suggests existing NinjaTickets pages that
// could naturally link to a keyword opportunity's target URL. Analyse-and-
// recommend only, per the brief: nothing here edits, fetches live HTML, or
// applies anything - it scores real, already-synced page data
// (common_crawl_pages: url + title, populated by the existing
// common-crawl-sync Edge Function) against the opportunity's own query/URL
// text.
//
// Deliberately does NOT claim to know whether a link already exists on a
// candidate source page - that would require fetching and parsing the
// page's live HTML, which is out of scope for this analysis-only phase (see
// notes on "Apply Safe Fix" as later work, where a real inspect step
// belongs). Every suggestion is explicit that this must still be verified
// by hand before adding a link - never invented, never assumed.
import type { CommonCrawlPage } from "@/types/database";

export interface InternalLinkSuggestion {
  sourceUrl: string;
  sourceTitle: string | null;
  targetUrl: string;
  /** Shared, real tokens (from title/URL text) that drove this suggestion -
   * never a fabricated semantic judgement. */
  matchedTerms: string[];
  /** True when this source page has its own real Search Console visibility
   * (it already ranks for at least one tracked query) - a proxy for
   * existing authority, since page-level authority data isn't tracked. */
  hasSearchVisibility: boolean;
  /** Relative score for ranking suggestions only - not a percentage or a
   * calibrated probability. */
  relevanceScore: number;
  /** Derived mechanically from the source page's own real URL/title text -
   * never invented copy. Always verify against the actual page before use. */
  suggestedAnchor: string;
  /** This tool doesn't fetch live page HTML, so it never claims to know
   * whether a link already exists - always "not-inspected" today. */
  existingLinkStatus: "not-inspected";
}

export interface FindInternalLinkOpportunitiesInput {
  targetUrl: string;
  targetQuery: string;
  /** Every other page already known for this site's domain
   * (common_crawl_pages, filtered to is_active by the caller if desired). */
  candidatePages: CommonCrawlPage[];
  /** Ranking URLs already seen elsewhere in the current opportunities
   * dataset - real, already-computed Search Console evidence of visibility,
   * not a new fetch. */
  pagesWithSearchVisibility: ReadonlySet<string>;
  /** Default 5 - caps suggestions so this never turns into "link from every
   * page sitewide". */
  maxSuggestions?: number;
}

const DEFAULT_MAX_SUGGESTIONS = 5;
const MIN_TOKEN_LENGTH = 3;

// Generic site/ticketing/English-filler words that appear on almost every
// NinjaTickets page - excluded so two unrelated pages don't score as
// "relevant" just because they both say "tickets" or "guide". Kept short
// and specific to this site's own vocabulary, not a general NLP stopword
// list.
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "your",
  "you",
  "are",
  "is",
  "in",
  "at",
  "on",
  "to",
  "of",
  "a",
  "an",
  "book",
  "buy",
  "find",
  "best",
  "top",
  "guide",
  "guides",
  "things",
  "do",
  "near",
  "tickets",
  "ticket",
  "event",
  "events",
  "ninjatickets",
  "com",
  "www",
  "http",
  "https",
  "html",
  "index",
  "co",
  "uk",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t),
  );
}

/** Handles both an absolute URL and a bare path - common_crawl_pages rows
 * may store either depending on how the crawl source returned them. */
function pathOf(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
  }
}

function slugWords(urlOrPath: string): string[] {
  return pathOf(urlOrPath)
    .split("/")
    .filter(Boolean)
    .flatMap((segment) => tokenize(segment.replace(/-/g, " ")));
}

/** A natural-language anchor derived mechanically from the target's own URL
 * slug - e.g. "/event/llandudno-chocolate-experience-llandudno/" becomes
 * "Llandudno Chocolate Experience". Collapses repeated words (a common
 * artefact of how event slugs are built - the location often appears both
 * as a prefix and a suffix) rather than inventing new wording. Always a
 * starting point to verify against the real page title, never a guarantee
 * of the actual title. */
export function naturalAnchorFromSlug(urlOrPath: string): string {
  const segments = pathOf(urlOrPath).split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const words = last.split("-").filter(Boolean);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(w);
  }
  return deduped
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Ranks existing pages by genuine relevance to a target opportunity, using
 * only real title/URL text already stored - never fetches, never invents.
 * Returns only pages with at least one real shared term (a page with zero
 * relevance is never suggested just to fill a quota - "avoid linking from
 * unrelated pages just for SEO").
 */
export function findInternalLinkOpportunities(
  input: FindInternalLinkOpportunitiesInput,
): InternalLinkSuggestion[] {
  const {
    targetUrl,
    targetQuery,
    candidatePages,
    pagesWithSearchVisibility,
    maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
  } = input;

  const targetPath = pathOf(targetUrl);
  const targetTokens = new Set([
    ...tokenize(targetQuery),
    ...slugWords(targetUrl),
  ]);
  if (targetTokens.size === 0) return [];

  const suggestions: InternalLinkSuggestion[] = [];

  for (const page of candidatePages) {
    if (!page.url || pathOf(page.url) === targetPath) continue; // never link a page to itself

    const titleTokens = tokenize(page.title ?? "");
    const urlTokens = slugWords(page.url);
    const pageTokenSet = new Set([...titleTokens, ...urlTokens]);
    const urlTokenSet = new Set(urlTokens);

    const matched = [...targetTokens].filter((t) => pageTokenSet.has(t));
    if (matched.length === 0) continue; // no genuine shared relevance

    // A shared term appearing in the URL path (not just the title) is a
    // stronger structural relevance signal for this site.
    const urlMatchBonus = matched.filter((t) => urlTokenSet.has(t)).length;
    const hasSearchVisibility = pagesWithSearchVisibility.has(
      pathOf(page.url),
    );
    const relevanceScore =
      matched.length + urlMatchBonus + (hasSearchVisibility ? 1 : 0);

    suggestions.push({
      sourceUrl: page.url,
      sourceTitle: page.title,
      targetUrl,
      matchedTerms: matched.sort(),
      hasSearchVisibility,
      relevanceScore,
      suggestedAnchor: naturalAnchorFromSlug(targetUrl),
      existingLinkStatus: "not-inspected",
    });
  }

  return suggestions
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxSuggestions);
}
