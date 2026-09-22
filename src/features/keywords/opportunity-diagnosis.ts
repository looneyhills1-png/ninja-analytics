// Evidence-based diagnosis for a single keyword opportunity - the shared
// logic behind both the Opportunities page's expanded-row display and the
// Generate Fix Prompt text, so the two never drift apart. Everything here is
// derived only from the row's own already-computed Search Console fields
// (position/impressions/clicks/ctr/categories) - nothing about the live page
// itself (title, content, links) is known here, so this module never makes
// claims about page content; see the "Existing page evidence" section in
// generateFixPrompt.ts for that honesty boundary.
//
// Deliberately NOT a generic "improve content" message generator - each
// category gets a specific, evidence-based diagnosis matching the shape of
// its actual signal (see the brief's worked examples: position 4-8 + high
// impressions + poor CTR -> CTR first; page 2 -> relevance/content/
// internal-link strength; cannibalisation -> inspect competing URLs first;
// content decay -> identify what changed before rewriting).
import { expectedCtrForPosition } from "@/lib/opportunity-score";
import { formatCtr, formatNumber, formatPosition } from "@/lib/format";
import type {
  KeywordOpportunityRow,
  OpportunityCategory,
} from "@/lib/keyword-opportunities";
import { CATEGORY_ORDER } from "@/features/keywords/opportunity-meta";

export interface OpportunityDiagnosis {
  /** True when CTR, not relevance/content, is the primary measurable
   * weakness - the page already ranks well but isn't converting impressions
   * into clicks. */
  ctrFirst: boolean;
  /** The measurable ranking/relevance problem, from Search Console signals. */
  seoWeakness: string;
  /** The measurable click-through problem, from Search Console signals. */
  ctrWeakness: string;
  /** What's already working and should be preserved, not rewritten away. */
  preserve: string;
  /** The single recommended priority action - specific to the evidence,
   * never a generic "improve content" instruction. */
  priorityAction: string;
}

function categoriesInOrder(
  categories: OpportunityCategory[],
): OpportunityCategory[] {
  return [...categories].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
  );
}

// A "good position, weak clicks" query is a CTR problem, not a content
// problem - the ranking already proves relevance. MIN_IMPRESSIONS here
// deliberately matches the engine's own "meaningful data" floor
// (keyword-opportunities.ts's MIN_IMPRESSIONS_FOR_OPPORTUNITY) rather than a
// new number, so this doesn't fire on noise.
const CTR_FIRST_MIN_IMPRESSIONS = 10;
const CTR_FIRST_MAX_POSITION = 10;

export function isCtrFirstCase(row: KeywordOpportunityRow): boolean {
  const rankingWell =
    row.currentPosition != null &&
    row.currentPosition <= CTR_FIRST_MAX_POSITION;
  const hasMeaningfulImpressions = row.impressions >= CTR_FIRST_MIN_IMPRESSIONS;
  const effectivelyNoClicks = row.clicks === 0;
  return (
    row.categories.includes("high-impression-low-ctr") ||
    (rankingWell && hasMeaningfulImpressions && effectivelyNoClicks)
  );
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

const PRIORITY_ACTION_BY_CATEGORY: Partial<
  Record<OpportunityCategory, string>
> = {
  cannibalisation:
    "Inspect every competing URL below before recommending new content - consolidate onto the single strongest page rather than creating another.",
  "content-decay":
    "Identify what changed (a ranking loss, thinned internal links, or removed/outdated information) before rewriting anything - don't assume the content is simply stale.",
  "wrong-page":
    "Confirm whether the current ranking URL is actually the intended page before making any change - don't improve the wrong page.",
  "page-2":
    "Relevance, content depth, and internal-link strength are the priority - the page isn't yet earning enough authority signal to reach page 1.",
  "strike-now":
    "On-page relevance and internal linking are the priority; title/H1/meta only if genuinely justified by the evidence.",
  "ranking-url-changed":
    "Confirm the new ranking URL is correct, then update internal links that still point at the old one.",
  falling:
    "Check for a ranking drop or a competitor gaining ground before assuming a content problem.",
  rising:
    "The momentum is real - reinforce it with internal links or supporting content rather than a rewrite.",
  new: "Too early to diagnose a specific weakness - monitor and revisit once more data accumulates.",
  lost: "Check for a ranking loss, a removed/redirected page, or seasonality before any content change.",
};

function priorityActionLine(
  categories: OpportunityCategory[],
  ctrFirst: boolean,
): string {
  if (ctrFirst) {
    return "CTR is the first priority: the ranking itself already proves relevance, so fix title/meta/snippet clarity before any broader content change.";
  }
  for (const category of categoriesInOrder(categories)) {
    const action = PRIORITY_ACTION_BY_CATEGORY[category];
    if (action) return action;
  }
  return "No strong signal yet - monitor rather than acting.";
}

/** The single entry point - everything the UI and the Fix Prompt need,
 * computed once from the row's own real data. */
export function diagnoseOpportunity(
  row: KeywordOpportunityRow,
): OpportunityDiagnosis {
  const ctrFirst = isCtrFirstCase(row);
  return {
    ctrFirst,
    seoWeakness: seoWeaknessLine(row, row.categories),
    ctrWeakness: ctrWeaknessLine(row, ctrFirst),
    preserve: preserveLine(row),
    priorityAction: priorityActionLine(row.categories, ctrFirst),
  };
}
