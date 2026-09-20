// Branded vs non-branded query classification (CLAUDE.md Phase 1). Purely
// local/lexical - no external brand-detection API, no invented data. A query
// counts as branded when it contains one of the site's own brand tokens,
// derived from its domain and display name.

const STOPWORDS = new Set([
  "the",
  "and",
  "of",
  "for",
  "a",
  "an",
  "co",
  "www",
  "ltd",
  "inc",
  "llc",
]);

const COMMON_TLDS = new Set([
  "com",
  "co",
  "uk",
  "net",
  "org",
  "io",
  "app",
  "dev",
  "shop",
  "store",
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Brand tokens for a site: every meaningful word from its domain (minus TLD
 * segments) plus every meaningful word from its display name, deduped.
 * "meaningful" = not a stopword/TLD and at least 3 characters, so short noise
 * tokens ("co", "uk") never cause a false branded match.
 */
export function brandTokensFor(site: {
  domain: string;
  name: string;
}): string[] {
  const domainTokens = tokenize(site.domain).filter((t) => !COMMON_TLDS.has(t));
  const nameTokens = tokenize(site.name);
  const all = [...domainTokens, ...nameTokens];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of all) {
    if (STOPWORDS.has(t) || t.length < 3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** True when the query contains any brand token as a whole word. */
export function isBrandedQuery(query: string, brandTokens: string[]): boolean {
  if (brandTokens.length === 0) return false;
  const queryTokens = new Set(tokenize(query));
  return brandTokens.some((t) => queryTokens.has(t));
}
