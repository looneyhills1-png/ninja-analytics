// Builds a ready-to-copy prompt for Claude/Codex from a single keyword
// opportunity row - a quick, low-risk "hand this to an agent" helper, not
// autonomous publishing. Pure string-building only: no fetch, no edit, no
// commit, no deploy. Everything derived from real row data comes from data
// this app already computed and is already showing on screen for that row -
// nothing invented, nothing fetched fresh. Anything this tool genuinely
// cannot know (live page content) is labelled "Not inspected / unavailable"
// rather than guessed, and the generated prompt tells the implementing agent
// to inspect the real page before acting.
//
// 2026-09-22 revision: prompts previously optimized for SEO alone ("improve
// content depth, internal links, title/H1/meta") without regard to whether
// that actually makes the page more useful, more clickable, or stronger for
// monetisation. Every generated prompt now evaluates three goals together -
// SEO improvement, user value/content quality, and AdSense readiness - see
// sections 3 ("Diagnosis") and 5 ("User-value improvements") below.
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
} from "@/features/keywords/opportunity-meta";
import { expectedCtrForPosition } from "@/lib/opportunity-score";
import { formatCtr, formatNumber, formatPosition } from "@/lib/format";
import type {
  KeywordOpportunityRow,
  OpportunityCategory,
} from "@/lib/keyword-opportunities";

export interface FixPromptSite {
  domain: string;
  name: string;
}

/**
 * Category-specific implementation guidance, only for the categories the
 * brief actually specified concrete instructions for. A row whose only
 * categories fall outside this map still gets a full prompt - it just relies
 * on the row's own recommendedAction (already included above) instead of a
 * dedicated checklist that wasn't requested.
 */
const CATEGORY_INSTRUCTIONS: Partial<Record<OpportunityCategory, string[]>> = {
  "strike-now": [
    "Inspect the existing ranking page first.",
    "Do not create a competing URL unless clearly necessary.",
    "Improve relevance and content depth.",
    "Strengthen internal linking to this page.",
    "Improve title/H1/meta only if genuinely justified by the above.",
    "Preserve existing affiliate/event functionality - do not break ticket CTAs, provider links, or structured data.",
  ],
  "page-2": [
    "Inspect the existing ranking page first.",
    "Do not create a competing URL unless clearly necessary.",
    "Improve relevance and content depth.",
    "Strengthen internal linking to this page.",
    "Improve title/H1/meta only if genuinely justified by the above.",
    "Preserve existing affiliate/event functionality - do not break ticket CTAs, provider links, or structured data.",
  ],
  "high-impression-low-ctr": [
    "Focus on title/meta description/snippet alignment with the actual query.",
    "Do not unnecessarily rewrite the whole page - this is a click-through problem, not (necessarily) a relevance problem.",
  ],
  cannibalisation: [
    "Inspect every competing URL listed below.",
    "Choose the single strongest, most intended page as canonical for this query.",
    "Merge, de-optimise, or internally relink the others as appropriate - don't leave multiple pages actively fighting for the same query.",
  ],
  "content-decay": [
    "Compare the current content against what was on the page when it performed better, if that history is available.",
    "Refresh stale sections (dates, prices, availability, outdated references) - never invent facts that can't be verified.",
    "Check for a ranking loss and whether internal links to this page have thinned out.",
  ],
  "wrong-page": [
    "Determine whether the current ranking URL is actually the best match for this query's intent.",
    "Either improve targeting on this page, or consolidate/redirect to the page that's the correct match - don't create a near-duplicate.",
  ],
};

// A "good position, weak clicks" query is a CTR problem, not a content
// problem - the ranking already proves relevance. MIN_IMPRESSIONS here
// deliberately matches the engine's own "meaningful data" floor
// (keyword-opportunities.ts's MIN_IMPRESSIONS_FOR_OPPORTUNITY) rather than
// a new number, so this doesn't fire on noise.
const CTR_FIRST_MIN_IMPRESSIONS = 10;
const CTR_FIRST_MAX_POSITION = 10;

function isCtrFirstCase(row: KeywordOpportunityRow): boolean {
  const rankingWell =
    row.currentPosition != null && row.currentPosition <= CTR_FIRST_MAX_POSITION;
  const hasMeaningfulImpressions = row.impressions >= CTR_FIRST_MIN_IMPRESSIONS;
  const effectivelyNoClicks = row.clicks === 0;
  return (
    row.categories.includes("high-impression-low-ctr") ||
    (rankingWell && hasMeaningfulImpressions && effectivelyNoClicks)
  );
}

function categoriesInOrder(
  categories: OpportunityCategory[],
): OpportunityCategory[] {
  return [...categories].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
  );
}

function competingUrlsSection(row: KeywordOpportunityRow): string {
  if (row.competingUrls.length === 0) {
    return "No competing internal URLs detected for this query in the current window.";
  }
  return row.competingUrls.map((u) => `- ${u}`).join("\n");
}

function scoreExplanationSection(row: KeywordOpportunityRow): string {
  return [...row.score.factors]
    .sort((a, b) => b.points - a.points)
    .map((f) => `- ${f.label} (${f.points} pts): ${f.explanation}`)
    .join("\n");
}

function implementationInstructionsSection(
  categories: OpportunityCategory[],
): string {
  const ordered = categoriesInOrder(categories);
  const blocks: string[] = [];
  for (const category of ordered) {
    const instructions = CATEGORY_INSTRUCTIONS[category];
    if (!instructions) continue;
    blocks.push(
      `${CATEGORY_LABEL[category]}:\n${instructions.map((i) => `- ${i}`).join("\n")}`,
    );
  }
  if (blocks.length === 0) {
    return "No category-specific checklist applies here beyond the recommended action above - follow it, plus the general rules below.";
  }
  return blocks.join("\n\n");
}

// Nothing about the real page (title, content, schema, etc.) is fetched by
// this tool - every field here is genuinely unknown to it. Stated plainly,
// per "if information cannot be verified, omit it or clearly mark it as
// unavailable" - never guessed or left implicit.
function pageEvidenceSection(): string {
  const fields = [
    "Title",
    "Meta description",
    "H1",
    "Main content",
    "Price",
    "CTA/provider",
    "Structured data",
    "Internal links",
    "Images",
  ];
  return [
    "This tool does not fetch live page content - inspect the real page before changing anything. Every field below is unconfirmed until you do:",
    ...fields.map((f) => `- ${f}: Not inspected / unavailable`),
  ].join("\n");
}

const SEO_WEAKNESS_BY_CATEGORY: Partial<
  Record<OpportunityCategory, (row: KeywordOpportunityRow) => string>
> = {
  "strike-now": (row) =>
    `Ranking close to page 1 (position ${formatPosition(row.currentPosition)}) but not yet capturing page-1 visibility - relevance/authority signals are the likely gap.`,
  "page-2": (row) =>
    `On page 2 (position ${formatPosition(row.currentPosition)}) - needs a larger relevance/content push to reach page 1.`,
  cannibalisation: (row) =>
    `${row.competingUrls.length} internal pages are competing for this exact query, splitting relevance signals instead of consolidating them.`,
  "content-decay": () =>
    "Clicks have dropped sharply vs the previous period - likely a ranking loss, thinned internal links, or content going stale.",
  "wrong-page": () =>
    "The current ranking URL doesn't obviously match this query's wording - possible search-intent mismatch (weak heuristic - confirm by inspection).",
  "ranking-url-changed": () =>
    "The ranking URL changed recently - internal links pointing at the old URL may now be misdirected.",
  falling: () =>
    "Losing clicks recently without an obvious page-level cause yet identified from Search Console data alone.",
  lost: () =>
    "This query has stopped appearing - could be a ranking loss, a removed/redirected page, or seasonality.",
};

function seoWeaknessLine(
  row: KeywordOpportunityRow,
  categories: OpportunityCategory[],
): string {
  for (const category of categoriesInOrder(categories)) {
    const fn = SEO_WEAKNESS_BY_CATEGORY[category];
    if (fn) return fn(row);
  }
  return "No strong SEO ranking weakness identified from Search Console data alone.";
}

function ctrWeaknessLine(
  row: KeywordOpportunityRow,
  ctrFirst: boolean,
): string {
  if (ctrFirst) {
    return `Ranking is already strong (position ${formatPosition(row.currentPosition)}) but CTR is effectively zero on ${formatNumber(row.impressions)} impressions - this is the primary measurable weakness right now.`;
  }
  if (row.ctr != null && row.currentPosition != null) {
    const expected = expectedCtrForPosition(row.currentPosition);
    const gap =
      row.ctr < expected
        ? " - below the typical rate for this position."
        : " - in line with or above the typical rate for this position, not a CTR problem.";
    return `Actual CTR ${formatCtr(row.ctr)} vs a typical ~${formatCtr(expected)} at this position${gap}`;
  }
  return "Not enough click/impression data to assess CTR.";
}

function preserveLine(row: KeywordOpportunityRow): string {
  if (row.currentPosition != null && row.currentPosition <= 20) {
    return `Already ranks at position ${formatPosition(row.currentPosition)} with ${formatNumber(row.impressions)} impressions - this existing visibility and relevance is real; preserve it, don't rewrite the page from scratch.`;
  }
  if (row.clicks > 0) {
    return `Already receiving some clicks (${formatNumber(row.clicks)}) - whatever is working on the page now should be kept, not discarded in a full rewrite.`;
  }
  return "No strong existing signal identified from Search Console data alone - there may still be good content on the page; inspect before rewriting anything.";
}

function diagnosisSection(
  row: KeywordOpportunityRow,
  categories: OpportunityCategory[],
  ctrFirst: boolean,
): string {
  return [
    `- SEO weakness: ${seoWeaknessLine(row, categories)}`,
    `- CTR weakness: ${ctrWeaknessLine(row, ctrFirst)}`,
    "- User-value/content weakness: Not inspected / unavailable - assess against the user-value checklist in section 5 once you've opened the real page.",
    "- Monetisation-quality weakness: Not inspected / unavailable - assess against the AdSense-readiness guidance in section 5 once you've opened the real page.",
    `- Already good (preserve, don't rewrite): ${preserveLine(row)}`,
  ].join("\n");
}

function recommendedImprovementsSection(
  row: KeywordOpportunityRow,
  categories: OpportunityCategory[],
  ctrFirst: boolean,
): string {
  const parts: string[] = [];
  if (ctrFirst) {
    parts.push(
      `CTR-first: this query already ranks around position ${formatPosition(row.currentPosition)} with ${formatNumber(row.impressions)} impressions and ${formatNumber(row.clicks)} clicks - the ranking itself is already strong enough that CTR is the primary measurable weakness. Focus first on title tag, meta description, and on-page summary/snippet clarity, plus clearer ticket intent and price/availability wording where verified. Avoid a large content rewrite unless it's independently justified below.`,
    );
  }
  parts.push(row.recommendedAction);
  parts.push(implementationInstructionsSection(categories));
  return parts.join("\n\n");
}

const GENERAL_VALUE_AREAS = [
  "search intent match",
  "CTR/snippet appeal",
  "originality and usefulness",
  "practical visitor information",
  "affiliate-page value beyond just outbound links",
  "internal linking",
  "structured data",
  "trust/accuracy",
  "content depth",
  "page usability",
];

const EVENT_PAGE_CONSIDERATIONS = [
  "what the ticket includes",
  "verified price or from-price",
  "availability",
  "dates/times",
  "expected visit duration",
  "who it is suitable for",
  "accessibility",
  "location",
  "parking/public transport",
  "venue information",
  "what makes the experience distinctive",
  "practical \"before you go\" advice",
  "FAQs based on real search intent",
  "nearby/relevant internal links",
  "useful images where legally available",
];

function userValueImprovementsSection(): string {
  return [
    "Evaluate and improve these areas where relevant (only where you can verify the underlying fact - omit or mark unavailable otherwise):",
    GENERAL_VALUE_AREAS.map((a) => `- ${a}`).join("\n"),
    "For event/attraction/ticket pages specifically, explicitly consider adding or improving, where verified:",
    EVENT_PAGE_CONSIDERATIONS.map((a) => `- ${a}`).join("\n"),
    "Rule: the page should provide enough useful information that a visitor benefits even if they never click an affiliate link.",
    "AdSense readiness: Improve this page's overall content quality and usefulness so it is stronger for users and better aligned with monetisation-quality expectations. Do not claim the page qualifies for AdSense or guarantee approval.",
  ].join("\n\n");
}

function safetyRulesSection(): string {
  return [
    "- Inspect before editing.",
    "- Make only evidence-based changes.",
    "- Do not invent facts, prices, dates, accessibility details, opening hours or facilities.",
    "- If information cannot be verified, omit it or clearly mark it as unavailable.",
    "- Do not pad pages with generic AI filler.",
    "- Do not keyword-stuff.",
    "- Do not copy user misspellings into page content.",
    "- Preserve strong existing content - prefer improving weak sections over rewriting everything.",
    "- Preserve existing affiliate/event functionality - do not break ticket CTAs, provider links, or structured data.",
    "- Do not create duplicate/competing pages when the existing ranking URL already matches intent.",
    "- Do not claim the page qualifies for AdSense or guarantee approval.",
    "- Run all relevant NinjaTickets quality/SEO gates.",
    "- Test the build.",
    "- Make one coherent commit.",
    "- Deploy once.",
    "- Do not repeatedly poll deploy status.",
    "- Report: files changed, commit hash, test/build result, deploy result.",
  ].join("\n");
}

/** Builds the full copy-paste prompt for a single opportunity row. */
export function buildFixPrompt(
  site: FixPromptSite,
  row: KeywordOpportunityRow,
): string {
  const categories = categoriesInOrder(row.categories);
  const categoryLabels = categories.map((c) => CATEGORY_LABEL[c]).join(", ");
  const ctrFirst = isCtrFirstCase(row);

  return `# NinjaTickets SEO fix prompt - keyword opportunity

## 1. Search opportunity
- Site: ${site.name} (${site.domain})
- Query: "${row.query}"
- Ranking URL: ${row.rankingUrl ?? "none on record for this query"}
- Category: ${categoryLabels || "none"}
- Position: ${formatPosition(row.currentPosition)}
- Impressions: ${formatNumber(row.impressions)} (previous period: ${formatNumber(row.impressionsPrev)})
- Clicks: ${formatNumber(row.clicks)} (previous period: ${formatNumber(row.clicksPrev)})
- CTR: ${formatCtr(row.ctr)}
- Trend: ${row.trend}
- First seen: ${row.firstSeen} - Last seen: ${row.lastSeen}
- Opportunity score: ${row.score.score}/100

Why this score was assigned:
${scoreExplanationSection(row)}

## Competing URLs / cannibalisation
${competingUrlsSection(row)}

## 2. Existing page evidence
${pageEvidenceSection()}

## 3. Diagnosis
${diagnosisSection(row, row.categories, ctrFirst)}

## 4. Recommended improvements
Only evidence-based changes - do not act on anything not actually supported by the data above.

${recommendedImprovementsSection(row, row.categories, ctrFirst)}

## 5. User-value improvements
${userValueImprovementsSection()}

## 6. Safety rules
${safetyRulesSection()}
`;
}
