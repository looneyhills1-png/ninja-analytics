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
//
// The diagnosis itself (measurable problem / what to preserve / priority
// action) lives in opportunity-diagnosis.ts, shared with the Opportunities
// page's own expanded-row display so the two never say different things
// about the same row. Internal-link suggestions (Phase 2, Internal Link
// Engine) are computed by the caller (internal-link-engine.ts, which needs
// the site's page inventory the caller already has loaded) and passed in -
// this file stays a pure function of data it's handed, never fetching
// anything itself.
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
} from "@/features/keywords/opportunity-meta";
import { diagnoseOpportunity } from "@/features/keywords/opportunity-diagnosis";
import type { InternalLinkSuggestion } from "@/features/keywords/internal-link-engine";
import type { CtrOpportunity } from "@/features/keywords/ctr-optimizer";
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
// this tool - every field here is genuinely unknown to it, EXCEPT title and
// meta description, which the CTR Optimizer (Phase 3) can supply from the
// last Site Audit crawl's captured data (still not a live fetch this run -
// the audit could be stale, so it's labelled as such). H1 is never given
// real text either way - only an H1 *count* is captured anywhere in this
// app, never the actual wording. Stated plainly, per "if information cannot
// be verified, omit it or clearly mark it as unavailable" - never guessed.
function pageEvidenceSection(ctrOpportunity?: CtrOpportunity): string {
  const evidence =
    ctrOpportunity?.pageEvidence.source === "site-audit"
      ? ctrOpportunity.pageEvidence
      : null;
  const lines = [
    evidence
      ? `- Title: "${evidence.title ?? ""}"${evidence.titleLength != null ? ` (${evidence.titleLength} characters, from the last Site Audit crawl - re-verify it's still current)` : ""}`
      : "- Title: Not inspected / unavailable",
    evidence
      ? evidence.metaDescription
        ? `- Meta description: "${evidence.metaDescription}"${evidence.metaDescriptionLength != null ? ` (${evidence.metaDescriptionLength} characters, from the last Site Audit crawl)` : ""}`
        : "- Meta description: Not captured by the last Site Audit crawl (Google is likely auto-generating it)"
      : "- Meta description: Not inspected / unavailable",
    evidence
      ? `- H1: Not captured as text anywhere in this app (only a count is tracked: ${evidence.h1Count ?? "unknown"}) - inspect the real page for the actual wording.`
      : "- H1: Not inspected / unavailable",
    "- Main content: Not inspected / unavailable",
    "- Price: Not inspected / unavailable",
    "- CTA/provider: Not inspected / unavailable",
    "- Structured data: Not inspected / unavailable",
    "- Internal links: Not inspected / unavailable",
    "- Images: Not inspected / unavailable",
  ];
  return [
    "This tool does not fetch live page content - inspect the real page before changing anything. Every field below is unconfirmed until you do:",
    ...lines,
  ].join("\n");
}

// Phase 3, CTR Optimizer - only rendered when the caller has identified this
// row as a CTR opportunity (position ~1-10, meaningful impressions, CTR
// materially below the position benchmark). The benchmark itself, the gap,
// and the missed-click estimate are always labelled with their real source
// (this site's own observed data, or the documented heuristic curve) - see
// ctr-benchmark.ts. Diagnosis flags never assume a rewrite is needed; only
// evidence-based flags are confirmed issues.
function ctrDiagnosisSection(o: CtrOpportunity): string {
  const sourceNote =
    o.expectedCtrSource === "observed"
      ? `this site's own observed CTR at this position (${formatNumber(o.expectedCtrSampleImpressions ?? 0)} impressions across ${o.expectedCtrSampleQueries ?? 0} queries in the current window)`
      : "a documented generic industry-pattern heuristic curve - not a NinjaTickets-specific figure (not enough first-party data yet at this position to compute an observed rate)";
  return [
    `- Actual CTR: ${formatCtr(o.actualCtr)}`,
    `- Expected CTR: ${formatCtr(o.expectedCtr)} - from ${sourceNote}`,
    `- CTR gap: ${formatCtr(o.ctrGapAbsolute)} (${o.ctrGapRelativePct.toFixed(0)}% below expected)`,
    `- Estimated missed clicks: ~${formatNumber(o.estimatedMissedClicks)} (impressions x CTR gap - an estimate assuming this page could reach the benchmark, not a guarantee)`,
    "",
    "Weakness diagnosis - do not automatically assume a title/meta rewrite is required; only [evidence-based] flags below are confirmed issues, [heuristic] flags need manual verification, and [not-assessable] flags genuinely can't be judged from GSC data alone:",
    ...o.diagnosisFlags.map(
      (f) => `- ${f.weakness} [${f.confidence}]: ${f.explanation}`,
    ),
    "",
    `Recommended change: ${o.recommendedChange}`,
  ].join("\n");
}

function ctrSafetyRulesSection(): string {
  return [
    "- Inspect the actual page first - the Title/Meta above are from the last Site Audit crawl, not a live fetch this run.",
    "- Preserve facts and working content - do not rewrite the whole page for a click-through problem.",
    "- Improve search-result appeal without clickbait.",
    "- Never invent prices, dates, availability or offers.",
    "- Never keyword-stuff.",
    "- Keep the title within a sensible SERP length (~60 characters).",
    "- Keep the meta description concise and useful (~50-160 characters).",
    "- Use the exact query naturally where justified - do not force it in unnaturally.",
    "- Consider whether on-page summary copy should also change, so Google is more likely to use the intended snippet instead of rewriting it.",
    "- Do not automatically assume a title/meta/H1 rewrite is required - preserve them if they're already strong.",
  ].join("\n");
}

function diagnosisSection(row: KeywordOpportunityRow): string {
  const diagnosis = diagnoseOpportunity(row);
  return [
    `- SEO weakness: ${diagnosis.seoWeakness}`,
    `- CTR weakness: ${diagnosis.ctrWeakness}`,
    "- User-value/content weakness: Not inspected / unavailable - assess against the user-value checklist in section 5 once you've opened the real page.",
    "- Monetisation-quality weakness: Not inspected / unavailable - assess against the AdSense-readiness guidance in section 5 once you've opened the real page.",
    `- Already good (preserve, don't rewrite): ${diagnosis.preserve}`,
  ].join("\n");
}

function recommendedImprovementsSection(
  row: KeywordOpportunityRow,
  categories: OpportunityCategory[],
): string {
  const diagnosis = diagnoseOpportunity(row);
  const parts: string[] = [];
  if (diagnosis.ctrFirst) {
    parts.push(
      `CTR-first: this query already ranks around position ${formatPosition(row.currentPosition)} with ${formatNumber(row.impressions)} impressions and ${formatNumber(row.clicks)} clicks - the ranking itself is already strong enough that CTR is the primary measurable weakness. Focus first on title tag, meta description, and on-page summary/snippet clarity, plus clearer ticket intent and price/availability wording where verified. Avoid a large content rewrite unless it's independently justified below.`,
    );
  }
  parts.push(row.recommendedAction);
  parts.push(implementationInstructionsSection(categories));
  return parts.join("\n\n");
}

// Phase 2, Internal Link Engine - suggestions are computed by the caller
// (which has the site's page inventory loaded) and simply rendered here.
// Every suggestion already carries its own honesty boundary
// (existingLinkStatus is always "not-inspected" - this tool never fetches
// live HTML to check), so this just formats what it's given.
function internalLinkOpportunitiesSection(
  suggestions: InternalLinkSuggestion[] | undefined,
): string {
  if (suggestions === undefined) {
    return "Not analysed this run - no page inventory was available. Verify manually whether a relevant existing NinjaTickets page could link to this URL.";
  }
  if (suggestions.length === 0) {
    return "No genuinely relevant existing page found in the current page inventory - do not add an internal link from an unrelated page just for SEO.";
  }
  return suggestions
    .map((s, i) => {
      const visibility = s.hasSearchVisibility
        ? "yes - this source page already has its own Search Console visibility"
        : "not known to rank for any tracked query";
      const linkStatus =
        s.targetLinkStatus === "target-weakly-linked"
          ? "the current internal-link audit flags this target as weakly linked overall - a new link here is genuinely valuable"
          : s.targetLinkStatus === "target-well-linked"
            ? "the current internal-link audit shows this target is already adequately linked overall - a new link is lower priority, and check this specific source doesn't already link to it before adding one"
            : "existing link not verified - the internal-link audit wasn't reachable this run; confirm by hand whether this source already links to the target";
      return [
        `${i + 1}. Source page: ${s.sourceUrl}${s.sourceTitle ? ` (${s.sourceTitle})` : ""}`,
        `   Target page: ${s.targetUrl}`,
        `   Suggested anchor: "${s.suggestedAnchor}" (derived from the URL - verify against the real page title before use)`,
        `   Reason/relevance: shares real terms with this query/URL - ${s.matchedTerms.join(", ")}`,
        `   Source page authority/visibility: ${visibility}`,
        `   Existing link status: ${linkStatus}`,
      ].join("\n");
    })
    .join("\n\n");
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
  'practical "before you go" advice',
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

/** Builds the full copy-paste prompt for a single opportunity row.
 * `internalLinkSuggestions` is optional (and computed by the caller, not
 * here) - omit it entirely when no page inventory is loaded yet, or pass an
 * empty array once genuinely analysed and found empty; the two render
 * different, honest messages (see internalLinkOpportunitiesSection).
 * `ctrOpportunity` (Phase 3, CTR Optimizer) is also optional and computed by
 * the caller - when present, real title/meta evidence (if the caller's Site
 * Audit data has it) replaces the generic "Not inspected" placeholders, and
 * a dedicated CTR diagnosis section + CTR-specific safety rules are added. */
export function buildFixPrompt(
  site: FixPromptSite,
  row: KeywordOpportunityRow,
  internalLinkSuggestions?: InternalLinkSuggestion[],
  ctrOpportunity?: CtrOpportunity,
): string {
  const categories = categoriesInOrder(row.categories);
  const categoryLabels = categories.map((c) => CATEGORY_LABEL[c]).join(", ");

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
${pageEvidenceSection(ctrOpportunity)}

## 3. Diagnosis
${diagnosisSection(row)}
${ctrOpportunity ? `\n### 3a. CTR opportunity diagnosis (Phase 3)\n${ctrDiagnosisSection(ctrOpportunity)}\n` : ""}
## 4. Recommended improvements
Only evidence-based changes - do not act on anything not actually supported by the data above.

${recommendedImprovementsSection(row, row.categories)}

## 5. User-value improvements
${userValueImprovementsSection()}

## 6. Internal link opportunities
Analyse and recommend only - do not add these links yet.
${internalLinkOpportunitiesSection(internalLinkSuggestions)}

## 7. Safety rules
${safetyRulesSection()}
${ctrOpportunity ? `\n## 8. CTR-specific rules\n${ctrSafetyRulesSection()}\n` : ""}`;
}
