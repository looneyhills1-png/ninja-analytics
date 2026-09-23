// Indexing priority engine (Ranking Growth Roadmap Phase 4). Turns data this
// app already has - GSC keyword opportunities, the site's own sitemap
// lastmod dates, cached URL Inspection state, and (optionally) Site Audit
// technical flags - into a small, priority-ranked list of URLs worth
// inspecting with Google's real URL Inspection API. This is deliberately
// NOT "inspect every URL on the site": the candidate set below is built
// only from URLs this app already has real signal for (a GSC ranking, a
// recent sitemap change, or a prior inspection), so a site with thousands
// of pages never produces thousands of inspection candidates.
//
// Every priority score is "show your working" (CLAUDE.md) - see `reasons`
// on each candidate, and REASON_WEIGHTS below documents exactly what each
// factor contributes.

import { expectedCtrForPosition } from "@/lib/opportunity-score";
import type { KeywordOpportunityRow } from "@/lib/keyword-opportunities";
import type { UrlInspection } from "@/types/database";

export type IndexingPriorityLevel = "critical" | "high" | "medium" | "low";

export type IndexingPageType =
  | "homepage"
  | "event"
  | "guide"
  | "artist"
  | "venue"
  | "city-or-category"
  | "other";

export interface IndexingCandidate {
  url: string;
  pageType: IndexingPageType;
  bestQuery: string | null;
  currentPosition: number | null;
  impressions: number;
  clicks: number;
  actualCtr: number | null;
  opportunityScore: number | null;
  siteLastmod: string | null;
  inspection: UrlInspection | null;
  technicalFlags: string[];
  priorityScore: number;
  priorityLevel: IndexingPriorityLevel;
  reasons: string[];
}

// Weights sum to 1 - each is a documented share of the 0-100 priority score,
// same "explainable score" convention as lib/opportunity-score.ts.
const WEIGHTS = {
  position: 0.3, // priority factor 1: ranking positions 4-15
  ctrGap: 0.2, // priority factor 2: meaningful impressions, low CTR
  freshness: 0.2, // priority factors 3+4: newly published / changed since crawl / never inspected
  affiliateValue: 0.05, // priority factor 5: high-value ticket pages
  technical: 0.1, // priority factor 6: known technical/site-audit concerns
  newlyPublished: 0.15, // priority factor 3, kept distinct from generic freshness
};

const NEWLY_PUBLISHED_WINDOW_DAYS = 14;
const MIN_IMPRESSIONS_FOR_CANDIDATE = 5;
const MATERIAL_CTR_GAP_RATIO = 0.6; // actual CTR below 60% of the position benchmark

function pathOf(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath;
  }
}

export function classifyPageType(url: string): IndexingPageType {
  const path = pathOf(url);
  if (path === "/" || path === "") return "homepage";
  if (path.startsWith("/event/")) return "event";
  if (path.startsWith("/guides/")) return "guide";
  if (path.startsWith("/artist/")) return "artist";
  if (path.startsWith("/venue/")) return "venue";
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1) return "city-or-category";
  return "other";
}

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 86_400_000;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Position 4-15 scores highest (the priority brief's own definition of
 * "already ranking reasonably well") - outside that band there is either
 * little upside left (top 3) or too far back for inspection to be the
 * useful lever (way past page 2). */
function positionFactor(position: number | null): {
  value: number;
  reason: string | null;
} {
  if (position == null) return { value: 0, reason: null };
  if (position >= 4 && position <= 15) {
    return {
      value: 1,
      reason: `Ranking position #${position.toFixed(1)} (4-15 band) - already ranking reasonably well, worth confirming indexing is healthy.`,
    };
  }
  if (position < 4) {
    return {
      value: 0.2,
      reason: `Ranking position #${position.toFixed(1)} - already strong, lower urgency.`,
    };
  }
  if (position <= 30) {
    return { value: 0.35, reason: null };
  }
  return { value: 0.1, reason: null };
}

function ctrGapFactor(
  impressions: number,
  ctr: number | null,
  position: number | null,
): { value: number; reason: string | null } {
  if (impressions < MIN_IMPRESSIONS_FOR_CANDIDATE || ctr == null || position == null) {
    return { value: 0, reason: null };
  }
  const expected = expectedCtrForPosition(position);
  if (expected <= 0) return { value: 0, reason: null };
  const ratio = ctr / expected;
  if (ratio >= MATERIAL_CTR_GAP_RATIO) return { value: 0, reason: null };
  const gap = clamp01((expected - ctr) / expected);
  return {
    value: gap,
    reason: `${impressions.toLocaleString()} impressions but actual CTR ${(ctr * 100).toFixed(1)}% is well below the ~${(expected * 100).toFixed(1)}% typical at this position.`,
  };
}

function affiliateValueFactor(pageType: IndexingPageType): {
  value: number;
  reason: string | null;
} {
  if (pageType === "event") {
    return {
      value: 1,
      reason: "High-value ticket page (/event/) - direct affiliate/commercial relevance.",
    };
  }
  return { value: 0, reason: null };
}

function technicalFactor(flags: string[]): {
  value: number;
  reason: string | null;
} {
  if (flags.length === 0) return { value: 0, reason: null };
  return {
    value: 1,
    reason: `Technical concerns from the last Site Audit: ${flags.join(", ")}.`,
  };
}

function newlyPublishedFactor(
  siteLastmod: string | null,
  now: Date,
): { value: number; reason: string | null } {
  if (!siteLastmod) return { value: 0, reason: null };
  const lastmodDate = new Date(siteLastmod);
  if (Number.isNaN(lastmodDate.getTime())) return { value: 0, reason: null };
  const ageDays = daysBetween(now, lastmodDate);
  if (ageDays < 0 || ageDays > NEWLY_PUBLISHED_WINDOW_DAYS) {
    return { value: 0, reason: null };
  }
  return {
    value: clamp01(1 - ageDays / NEWLY_PUBLISHED_WINDOW_DAYS),
    reason: `Published/updated ${siteLastmod} (within the last ${NEWLY_PUBLISHED_WINDOW_DAYS} days) - not yet confirmed indexed.`,
  };
}

/**
 * "Never inspected" and "changed since Google's last crawl" are mutually
 * exclusive by construction (the second needs a prior inspection to compare
 * against), so they share one weight slot rather than double-counting.
 */
function freshnessFactor(
  inspection: UrlInspection | null,
  siteLastmod: string | null,
): { value: number; reason: string | null } {
  if (!inspection) {
    return {
      value: 0.6,
      reason: "Never inspected - indexing status unknown.",
    };
  }
  if (!siteLastmod || !inspection.last_crawl_time) return { value: 0, reason: null };
  const lastmodDate = new Date(siteLastmod);
  const crawlDate = new Date(inspection.last_crawl_time);
  if (Number.isNaN(lastmodDate.getTime()) || Number.isNaN(crawlDate.getTime())) {
    return { value: 0, reason: null };
  }
  if (lastmodDate.getTime() <= crawlDate.getTime()) return { value: 0, reason: null };
  return {
    value: 1,
    reason: `Page content changed on ${siteLastmod}, after Google's last crawl (${inspection.last_crawl_time.slice(0, 10)}) - Google may be serving stale info.`,
  };
}

function priorityLevelFor(score: number): IndexingPriorityLevel {
  if (score >= 70) return "critical";
  if (score >= 50) return "high";
  if (score >= 30) return "medium";
  return "low";
}

export interface BuildIndexingCandidatesInput {
  opportunityRows: KeywordOpportunityRow[];
  /** Absolute URL -> ISO/date-only lastmod string from the site's own
   * sitemap.xml (fetchSitemapLastmods). */
  siteLastmods: Map<string, string>;
  /** Absolute URL -> the current cached inspection state, if any. */
  inspections: Map<string, UrlInspection>;
  /** Absolute URL -> technical concern labels from the latest Site Audit
   * (e.g. "noindex", "non-self canonical") - optional, empty map if no
   * audit data is available. */
  technicalFlagsByUrl?: Map<string, string[]>;
  now?: Date;
}

/**
 * Builds the bounded candidate set (see module doc) and scores each one.
 * Sorted by priority score descending - the caller decides how much of the
 * list to actually show/act on.
 */
export function buildIndexingCandidates(
  input: BuildIndexingCandidatesInput,
): IndexingCandidate[] {
  const now = input.now ?? new Date();
  const technicalFlagsByUrl = input.technicalFlagsByUrl ?? new Map();

  // Best (highest opportunity score) row per ranking URL.
  const bestRowByUrl = new Map<string, KeywordOpportunityRow>();
  for (const row of input.opportunityRows) {
    if (!row.rankingUrl || row.impressions < MIN_IMPRESSIONS_FOR_CANDIDATE) continue;
    const existing = bestRowByUrl.get(row.rankingUrl);
    if (!existing || row.score.score > existing.score.score) {
      bestRowByUrl.set(row.rankingUrl, row);
    }
  }

  const candidateUrls = new Set<string>([
    ...bestRowByUrl.keys(),
    ...input.inspections.keys(),
    ...[...input.siteLastmods.entries()]
      .filter(([, lastmod]) => {
        const d = new Date(lastmod);
        return !Number.isNaN(d.getTime()) && daysBetween(now, d) <= NEWLY_PUBLISHED_WINDOW_DAYS;
      })
      .map(([url]) => url),
  ]);

  const candidates: IndexingCandidate[] = [];

  for (const url of candidateUrls) {
    const row = bestRowByUrl.get(url) ?? null;
    const inspection = input.inspections.get(url) ?? null;
    const siteLastmod = input.siteLastmods.get(url) ?? null;
    const technicalFlags = technicalFlagsByUrl.get(url) ?? [];
    const pageType = classifyPageType(url);

    const position = positionFactor(row?.currentPosition ?? null);
    const ctrGap = ctrGapFactor(
      row?.impressions ?? 0,
      row?.ctr ?? null,
      row?.currentPosition ?? null,
    );
    const newlyPublished = newlyPublishedFactor(siteLastmod, now);
    const freshness = freshnessFactor(inspection, siteLastmod);
    const affiliate = affiliateValueFactor(pageType);
    const technical = technicalFactor(technicalFlags);

    const priorityScore = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          (position.value * WEIGHTS.position +
            ctrGap.value * WEIGHTS.ctrGap +
            newlyPublished.value * WEIGHTS.newlyPublished +
            freshness.value * WEIGHTS.freshness +
            affiliate.value * WEIGHTS.affiliateValue +
            technical.value * WEIGHTS.technical) *
            100,
        ),
      ),
    );

    const reasons = [
      position.reason,
      ctrGap.reason,
      newlyPublished.reason,
      freshness.reason,
      affiliate.reason,
      technical.reason,
    ].filter((r): r is string => r != null);

    candidates.push({
      url,
      pageType,
      bestQuery: row?.query ?? null,
      currentPosition: row?.currentPosition ?? null,
      impressions: row?.impressions ?? 0,
      clicks: row?.clicks ?? 0,
      actualCtr: row?.ctr ?? null,
      opportunityScore: row?.score.score ?? null,
      siteLastmod,
      inspection,
      technicalFlags,
      priorityScore,
      priorityLevel: priorityLevelFor(priorityScore),
      reasons: reasons.length > 0 ? reasons : ["No strong signal - included for visibility only."],
    });
  }

  return candidates.sort((a, b) => b.priorityScore - a.priorityScore);
}

export type IndexingSummaryBucket =
  | "indexed"
  | "not_indexed"
  | "crawled_not_indexed"
  | "discovered_not_indexed"
  | "canonical_mismatch"
  | "blocked"
  | "never_inspected";

export function summaryBucketFor(
  candidate: Pick<IndexingCandidate, "inspection">,
): IndexingSummaryBucket {
  if (!candidate.inspection) return "never_inspected";
  const status = candidate.inspection.ninja_status;
  if (status === "unknown") return "never_inspected";
  return status;
}

export function summarizeIndexingCandidates(
  candidates: IndexingCandidate[],
): Record<IndexingSummaryBucket, number> {
  const summary: Record<IndexingSummaryBucket, number> = {
    indexed: 0,
    not_indexed: 0,
    crawled_not_indexed: 0,
    discovered_not_indexed: 0,
    canonical_mismatch: 0,
    blocked: 0,
    never_inspected: 0,
  };
  for (const c of candidates) {
    summary[summaryBucketFor(c)] += 1;
  }
  return summary;
}
