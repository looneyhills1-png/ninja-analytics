// Builds a ready-to-copy prompt for Claude/Codex from a single keyword
// opportunity row - a quick, low-risk "hand this to an agent" helper, not
// autonomous publishing. Pure string-building only: no fetch, no edit, no
// commit, no deploy. Everything in the prompt comes from data this app
// already computed and is already showing on screen for that row - nothing
// invented, nothing fetched fresh.
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
} from "@/features/keywords/opportunity-meta";
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

/** Builds the full copy-paste prompt for a single opportunity row. */
export function buildFixPrompt(
  site: FixPromptSite,
  row: KeywordOpportunityRow,
): string {
  const categories = categoriesInOrder(row.categories);
  const categoryLabels = categories.map((c) => CATEGORY_LABEL[c]).join(", ");

  return `# NinjaTickets SEO fix prompt - keyword opportunity

## Context
- Site: ${site.name} (${site.domain})
- Query: "${row.query}"
- Ranking URL: ${row.rankingUrl ?? "none on record for this query"}
- Opportunity type: ${categoryLabels || "none"}

## Current data (Search Console)
- Current position: ${formatPosition(row.currentPosition)}
- Clicks: ${formatNumber(row.clicks)} (previous period: ${formatNumber(row.clicksPrev)})
- Impressions: ${formatNumber(row.impressions)} (previous period: ${formatNumber(row.impressionsPrev)})
- CTR: ${formatCtr(row.ctr)}
- Trend: ${row.trend}
- First seen: ${row.firstSeen} - Last seen: ${row.lastSeen}

## Opportunity score: ${row.score.score}/100
Why this score was assigned:
${scoreExplanationSection(row)}

## Recommended action
${row.recommendedAction}

## Competing URLs / cannibalisation
${competingUrlsSection(row)}

## Implementation instructions
${implementationInstructionsSection(row.categories)}

## Rules (always)
- Inspect before editing.
- Make only evidence-based changes.
- Run all relevant NinjaTickets quality/SEO gates.
- Test the build.
- Make one coherent commit.
- Deploy once.
- Do not repeatedly poll deploy status.
- Report: files changed, commit hash, test/build result, deploy result.
`;
}
