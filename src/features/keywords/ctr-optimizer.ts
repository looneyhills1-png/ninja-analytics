// CTR Optimizer (Phase 3): detects queries that already rank reasonably
// well but are converting fewer clicks than expected for that position -
// prioritised above broad content rewrites, since the ranking itself
// already proves relevance. Analysis + diagnosis + prompt generation only
// - nothing here edits or publishes anything.
//
// Every number is computed from real GSC data already loaded by the caller
// (KeywordOpportunityRow, from computeKeywordOpportunities) plus, where
// available, real page evidence from the last Site Audit crawl
// (site_audit_pages: title/meta text and lengths - there is no H1 text
// captured, only an h1Count, so H1 content itself is always reported as not
// captured). Nothing about a page's real content is ever guessed - see
// SiteAuditPageEvidence and "not-inspected" below.
import { computeObservedCtrCurve, expectedCtrFor } from "@/lib/ctr-benchmark";
import type { CtrBenchmarkSource } from "@/lib/ctr-benchmark";
import { pathOf } from "@/lib/url-path";
import { tokenSet } from "@/lib/text-tokens";
import type { KeywordOpportunityRow } from "@/lib/keyword-opportunities";

// "Average position is roughly 1-10" - the whole first page, where a
// searcher can already see the result without scrolling to page 2.
const MIN_POSITION = 1;
const MAX_POSITION = 10;
// "Impressions are meaningful" - matches the meaningful-data floor used
// elsewhere in this app's opportunity engine (keyword-opportunities.ts's
// MIN_IMPRESSIONS_FOR_OPPORTUNITY), not a new number invented for this
// feature.
const MIN_IMPRESSIONS = 10;
// "CTR materially below the expected CTR for that position" - actual CTR
// at or under 75% of the benchmark counts as material, not just any gap.
const MATERIAL_GAP_RATIO = 0.75;

export interface SiteAuditPageEvidence {
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
  h1Count: number | null;
}

export interface CtrPageEvidence extends SiteAuditPageEvidence {
  source: "site-audit" | "not-inspected";
}

export type CtrWeakness =
  | "title-clarity"
  | "title-intent-mismatch"
  | "weak-value-proposition"
  | "missing-ticket-context"
  | "vague-meta-description"
  | "poor-differentiation"
  | "snippet-rewrite-likely";

export type CtrDiagnosisConfidence =
  | "evidence-based"
  | "heuristic"
  | "not-assessable";

export interface CtrDiagnosisFlag {
  weakness: CtrWeakness;
  confidence: CtrDiagnosisConfidence;
  explanation: string;
}

export interface CtrOpportunity {
  query: string;
  rankingUrl: string | null;
  currentPosition: number;
  impressions: number;
  clicks: number;
  actualCtr: number;
  expectedCtr: number;
  expectedCtrSource: CtrBenchmarkSource;
  expectedCtrSampleImpressions: number | null;
  expectedCtrSampleQueries: number | null;
  /** expectedCtr - actualCtr, as a raw CTR-point difference (e.g. 0.02 =
   * 2 percentage points). Always > 0 for a row that qualified. */
  ctrGapAbsolute: number;
  /** The gap as a percentage of the expected CTR - "how far below
   * benchmark", not a percentage-point figure. */
  ctrGapRelativePct: number;
  /** impressions * ctrGapAbsolute, rounded - only ever positive, since a
   * row only qualifies with a positive gap. Still an estimate: it assumes
   * this page could reach the benchmark CTR, which isn't guaranteed. */
  estimatedMissedClicks: number;
  pageEvidence: CtrPageEvidence;
  diagnosisFlags: CtrDiagnosisFlag[];
  recommendedChange: string;
}

const TICKET_CONTEXT_PATTERN =
  /[£$]|\bfrom\b|\b20\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/**
 * Diagnoses the seven weakness categories the brief specifies, always
 * returning exactly one flag per category (in the brief's own order) so the
 * UI/prompt can show a complete, consistent picture. Confidence is
 * "evidence-based" only when a real captured title/meta actually supports
 * the claim, "heuristic" for pattern-matched signals that need manual
 * verification, and "not-assessable" where GSC data genuinely can't tell
 * (matches "do not automatically assume a title/meta rewrite is required" -
 * most of these stay heuristic or not-assessable on purpose).
 */
export function diagnoseCtrWeakness(input: {
  query: string;
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
}): CtrDiagnosisFlag[] {
  const { query, title, titleLength, metaDescription, metaDescriptionLength } =
    input;
  const hasTitle = !!title && title.trim().length > 0;
  const hasMeta = !!metaDescription && metaDescription.trim().length > 0;
  const hasAnyEvidence = hasTitle || hasMeta || titleLength != null;
  const queryTokens = tokenSet(query);
  const titleTokens = hasTitle ? tokenSet(title as string) : new Set<string>();
  const titleOverlap = [...queryTokens].filter((t) => titleTokens.has(t));

  const flags: CtrDiagnosisFlag[] = [];

  // 1. Title clarity - a judgment call GSC data can't measure directly.
  flags.push({
    weakness: "title-clarity",
    confidence: "not-assessable",
    explanation: hasTitle
      ? "Whether the title reads clearly and appealingly to a searcher is a judgment call GSC data can't measure - read it as a searcher would before changing anything."
      : "No title captured by the last site audit - inspect the real page to judge title clarity.",
  });

  // 2. Title not matching query intent.
  flags.push(
    !hasTitle
      ? {
          weakness: "title-intent-mismatch",
          confidence: "not-assessable",
          explanation:
            "No title captured yet - inspect the real page to compare it against the query.",
        }
      : titleOverlap.length === 0
        ? {
            weakness: "title-intent-mismatch",
            confidence: "evidence-based",
            explanation: `The captured title ("${title}") shares no words with the query "${query}" - a likely mismatch that can suppress clicks.`,
          }
        : {
            weakness: "title-intent-mismatch",
            confidence: "evidence-based",
            explanation: `The title shares query terms (${titleOverlap.join(", ")}) - intent match looks fine on this measure.`,
          },
  );

  // 3. Weak value proposition - never computable directly, only a residual
  // heuristic prompt to check manually.
  flags.push({
    weakness: "weak-value-proposition",
    confidence: hasTitle ? "heuristic" : "not-assessable",
    explanation: hasTitle
      ? "Not directly measurable from GSC data. If the other checks here look fine but CTR is still low, the value proposition (price/availability/distinctiveness) may not be compelling enough - verify against the real page and the current Google results page."
      : "No page evidence captured yet - inspect the real page to judge the value proposition.",
  });

  // 4. Missing ticket/price/date/location context - pattern-matched, always
  // heuristic (a regex can't confirm the detail is real or verified).
  const combinedText = `${title ?? ""} ${metaDescription ?? ""}`;
  const ticketContextPresent = TICKET_CONTEXT_PATTERN.test(combinedText);
  flags.push({
    weakness: "missing-ticket-context",
    confidence: hasAnyEvidence ? "heuristic" : "not-assessable",
    explanation: !hasAnyEvidence
      ? "No title/meta captured yet - inspect the real page."
      : ticketContextPresent
        ? "Title/meta already mention what looks like a price, date, or 'from £' style detail (pattern-matched) - context looks present."
        : "Title/meta don't obviously mention a price, date, or 'from £' style detail (pattern-matched heuristic) - verify manually whether adding a real, verified detail would help.",
  });

  // 5. Vague meta description.
  if (!hasMeta) {
    flags.push({
      weakness: "vague-meta-description",
      confidence:
        metaDescriptionLength != null || hasTitle
          ? "evidence-based"
          : "not-assessable",
      explanation:
        metaDescriptionLength != null || hasTitle
          ? "No meta description captured - Google is likely auto-generating the snippet from page content, which may not sell the click."
          : "No page evidence captured yet - inspect the real page.",
    });
  } else {
    const metaTokens = tokenSet(metaDescription as string);
    const metaOverlap = [...queryTokens].filter((t) => metaTokens.has(t));
    const lengthIssue =
      metaDescriptionLength != null &&
      (metaDescriptionLength < 50 || metaDescriptionLength > 160);
    if (metaOverlap.length === 0 || lengthIssue) {
      const reasons = [
        metaOverlap.length === 0 ? "doesn't mention the query terms" : null,
        lengthIssue
          ? `is ${metaDescriptionLength} characters, outside the ~50-160 Google typically shows in full`
          : null,
      ].filter((r): r is string => r != null);
      flags.push({
        weakness: "vague-meta-description",
        confidence: "evidence-based",
        explanation: `Meta description ${reasons.join(" and ")}.`,
      });
    } else {
      flags.push({
        weakness: "vague-meta-description",
        confidence: "evidence-based",
        explanation:
          "Meta description mentions the query terms and is a reasonable length - looks fine on this measure.",
      });
    }
  }

  // 6. Poor differentiation from competing results - genuinely invisible
  // without fetching the live Google results page, which this analysis
  // phase deliberately never does (no scraping Google, no paid SERP API).
  flags.push({
    weakness: "poor-differentiation",
    confidence: "not-assessable",
    explanation:
      "Whether competing results look more compelling isn't visible from GSC data alone - compare manually against the live Google results page.",
  });

  // 7. Snippet likely being rewritten by Google - title length is the one
  // concrete, well-documented signal available without fetching the SERP.
  const longTitle = titleLength != null && titleLength > 60;
  flags.push({
    weakness: "snippet-rewrite-likely",
    confidence: titleLength != null ? "evidence-based" : "not-assessable",
    explanation:
      titleLength == null
        ? "No title length captured yet - inspect the real page."
        : longTitle
          ? `Title is ${titleLength} characters - over the ~60 Google typically shows, so it may already be truncated or replaced with an auto-generated snippet.`
          : `Title is ${titleLength} characters - within Google's typical display length, so a rewrite is less likely on length grounds alone (Google can still rewrite for other reasons).`,
  });

  return flags;
}

/** One line, evidence-first, never a default "rewrite the title" verdict -
 * "do not automatically assume a title/meta rewrite is required" and
 * "preserve titles/H1s that are already strong". */
function recommendedChangeFor(
  flags: CtrDiagnosisFlag[],
  hasEvidence: boolean,
): string {
  if (!hasEvidence) {
    return "Title/meta weren't captured by the last site audit - run a site audit (or inspect the real page) before deciding whether to change anything. Do not assume a rewrite is needed without looking.";
  }
  const genuineIssues = flags.filter(
    (f) =>
      f.confidence === "evidence-based" &&
      (f.weakness === "title-intent-mismatch" ||
        f.weakness === "snippet-rewrite-likely" ||
        f.weakness === "vague-meta-description") &&
      !/looks fine/.test(f.explanation),
  );
  if (genuineIssues.length === 0) {
    return "Title/meta look structurally fine (match the query, reasonable length) - preserve them as-is. If anything, strengthen the value proposition (verified price/availability/distinctiveness) rather than rewriting the title/H1.";
  }
  return `Evidence-based issue(s) found: ${genuineIssues.map((f) => f.weakness).join(", ")}. Fix these specifically - see the CTR Fix Prompt for exact guidance - rather than a full content rewrite.`;
}

export interface FindCtrOpportunitiesInput {
  rows: readonly KeywordOpportunityRow[];
  /** Keyed by URL path (see @/lib/url-path's pathOf) - from the latest
   * successful Site Audit crawl, if one has been run for this site. */
  pageEvidenceByUrl: ReadonlyMap<string, SiteAuditPageEvidence>;
}

/**
 * Detects queries that already rank on page 1 but convert materially fewer
 * clicks than the position-appropriate benchmark - prioritised above broad
 * content rewrites, since the ranking itself is evidence the page already
 * matches search intent reasonably well (Google put it there for this
 * query). Sorted by CTR gap, biggest first.
 */
export function findCtrOpportunities(
  input: FindCtrOpportunitiesInput,
): CtrOpportunity[] {
  const { rows, pageEvidenceByUrl } = input;
  const curve = computeObservedCtrCurve(rows);
  const out: CtrOpportunity[] = [];

  for (const row of rows) {
    if (row.currentPosition == null) continue;
    if (
      row.currentPosition < MIN_POSITION ||
      row.currentPosition > MAX_POSITION
    )
      continue;
    if (row.impressions < MIN_IMPRESSIONS) continue;

    const actualCtr = row.ctr ?? 0;
    const benchmark = expectedCtrFor(row.currentPosition, curve);
    if (benchmark.value <= 0) continue;
    if (actualCtr > benchmark.value * MATERIAL_GAP_RATIO) continue; // not material

    const ctrGapAbsolute = benchmark.value - actualCtr;
    if (ctrGapAbsolute <= 0) continue; // mathematically not a missed-click case
    const ctrGapRelativePct = (ctrGapAbsolute / benchmark.value) * 100;
    const estimatedMissedClicks = Math.round(row.impressions * ctrGapAbsolute);

    const path = row.rankingUrl ? pathOf(row.rankingUrl) : null;
    const evidence = path ? pageEvidenceByUrl.get(path) : undefined;
    const hasEvidence =
      !!evidence &&
      (evidence.title != null ||
        evidence.metaDescription != null ||
        evidence.titleLength != null);

    const flags = diagnoseCtrWeakness({
      query: row.query,
      title: evidence?.title ?? null,
      titleLength: evidence?.titleLength ?? null,
      metaDescription: evidence?.metaDescription ?? null,
      metaDescriptionLength: evidence?.metaDescriptionLength ?? null,
    });

    out.push({
      query: row.query,
      rankingUrl: row.rankingUrl,
      currentPosition: row.currentPosition,
      impressions: row.impressions,
      clicks: row.clicks,
      actualCtr,
      expectedCtr: benchmark.value,
      expectedCtrSource: benchmark.source,
      expectedCtrSampleImpressions: benchmark.sampleImpressions,
      expectedCtrSampleQueries: benchmark.sampleQueries,
      ctrGapAbsolute,
      ctrGapRelativePct,
      estimatedMissedClicks,
      pageEvidence: {
        source: hasEvidence ? "site-audit" : "not-inspected",
        title: evidence?.title ?? null,
        titleLength: evidence?.titleLength ?? null,
        metaDescription: evidence?.metaDescription ?? null,
        metaDescriptionLength: evidence?.metaDescriptionLength ?? null,
        h1Count: evidence?.h1Count ?? null,
      },
      diagnosisFlags: flags,
      recommendedChange: recommendedChangeFor(flags, hasEvidence),
    });
  }

  return out.sort((a, b) => b.ctrGapAbsolute - a.ctrGapAbsolute);
}
