// The Ninja Opportunity Score: an explainable 0-100 score built only from
// signals this app actually has (GSC/Bing history + locally computed
// heuristics). It is NOT Semrush's Keyword Difficulty or any other vendor's
// proprietary metric, and it never blends in a number this app cannot
// justify from its own data. Every factor below is exposed to the UI so the
// score is always "show your working", per CLAUDE.md.

export interface OpportunityFactor {
  key: string;
  label: string;
  /** Normalized 0-1 strength of this signal (1 = strongly favours this being
   * a good opportunity to act on). */
  value: number;
  /** Share of the total score this factor can contribute (weights sum to 1). */
  weight: number;
  /** value * weight * 100, rounded - this factor's actual point contribution. */
  points: number;
  explanation: string;
}

export interface OpportunityScoreInput {
  currentPosition: number | null;
  previousPosition: number | null;
  impressions: number;
  ctr: number | null;
  clicksChangePct: number | null;
  /** Std deviation of daily position across the window - null if too few
   * samples to compute meaningfully. Lower = more stable/trustworthy rank. */
  positionStability: number | null;
  /** Distinct internal URLs that received impressions for this query in the
   * current window - 2+ signals possible cannibalisation. */
  competingUrlCount: number;
  /** True if this query also has meaningful Bing impressions - a second,
   * independent engine corroborating real demand. */
  bingCorroboration: boolean;
}

export interface OpportunityScoreResult {
  score: number;
  factors: OpportunityFactor[];
}

/**
 * A generic, commonly-observed organic CTR-by-position benchmark curve.
 * This is general industry pattern knowledge (rankings 1-3 capture most
 * clicks, then a steep, well-documented drop-off), not any vendor's
 * proprietary model or dataset - used only as a rough "what CTR would be
 * typical here" yardstick to compute a CTR gap.
 */
const EXPECTED_CTR_BY_POSITION: Array<[number, number]> = [
  [1, 0.28],
  [2, 0.15],
  [3, 0.11],
  [4, 0.08],
  [5, 0.06],
  [6, 0.045],
  [7, 0.035],
  [8, 0.028],
  [9, 0.022],
  [10, 0.018],
  [15, 0.01],
  [20, 0.006],
  [30, 0.003],
  [50, 0.0015],
];

export function expectedCtrForPosition(position: number): number {
  if (position <= 1) return EXPECTED_CTR_BY_POSITION[0][1];
  for (let i = 0; i < EXPECTED_CTR_BY_POSITION.length - 1; i += 1) {
    const [posA, ctrA] = EXPECTED_CTR_BY_POSITION[i];
    const [posB, ctrB] = EXPECTED_CTR_BY_POSITION[i + 1];
    if (position >= posA && position <= posB) {
      const t = (position - posA) / (posB - posA);
      return ctrA + (ctrB - ctrA) * t;
    }
  }
  return EXPECTED_CTR_BY_POSITION[EXPECTED_CTR_BY_POSITION.length - 1][1];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Position-proximity signal: opportunity peaks around positions 4-15 (close
 * enough that real work can move it, not already on top and not so far back
 * that the gap is huge). Positions 1-3 score low (little upside left);
 * positions past ~40 score low (a long way from being competitive).
 */
function positionProximity(position: number | null): number {
  if (position == null) return 0;
  if (position <= 3) return 0.15;
  if (position <= 10) return 1 - (position - 3) * 0.03; // 4→0.97 .. 10→0.79
  if (position <= 20) return 0.75 - (position - 10) * 0.035; // 11→0.72 .. 20→0.4
  if (position <= 40) return Math.max(0.05, 0.4 - (position - 20) * 0.017);
  return 0.05;
}

/** Log-scaled demand signal so a 50k-impression query doesn't need to be
 * literally 1000x "more opportunity" than a 50-impression one. */
function demandSignal(impressions: number): number {
  if (impressions <= 0) return 0;
  return clamp01(Math.log10(1 + impressions) / 4); // ~10k impressions -> 1.0
}

function ctrGapSignal(ctr: number | null, position: number | null): number {
  if (ctr == null || position == null) return 0;
  const expected = expectedCtrForPosition(position);
  if (expected <= 0) return 0;
  const gap = (expected - ctr) / expected; // positive = underperforming
  return clamp01(gap);
}

function trendSignal(
  clicksChangePct: number | null,
  currentPosition: number | null,
  previousPosition: number | null,
): number {
  let signal = 0;
  if (clicksChangePct != null) {
    // Rising traffic = momentum worth reinforcing.
    if (clicksChangePct > 0)
      signal = Math.max(signal, clamp01(clicksChangePct / 100));
    // A recent decline on a query that still has real impressions is
    // actionable too - surfaced separately as a "falling" category, but the
    // score itself treats meaningful movement (either direction) as more
    // interesting than a flat line.
    else signal = Math.max(signal, clamp01(-clicksChangePct / 100) * 0.7);
  }
  if (currentPosition != null && previousPosition != null) {
    const posChange = previousPosition - currentPosition; // positive = improved
    if (posChange > 0) signal = Math.max(signal, clamp01(posChange / 10));
  }
  return signal;
}

/** Lower day-to-day position variance = a more trustworthy, actionable
 * signal (a rank bouncing 5-40 daily is noisy, not a real "position 12").
 * `hasSignal` distinguishes "unknown because there's simply no data at all"
 * (no credit) from "unknown because there aren't enough daily samples yet
 * on a query that otherwise has real position/demand data" (neutral, not
 * penalised). */
function stabilitySignal(
  positionStability: number | null,
  hasSignal: boolean,
): number {
  if (positionStability == null) return hasSignal ? 0.5 : 0;
  return clamp01(1 - positionStability / 15);
}

function cannibalisationSignal(competingUrlCount: number): number {
  if (competingUrlCount <= 1) return 0;
  return clamp01((competingUrlCount - 1) / 3);
}

function bingSignal(bingCorroboration: boolean): number {
  return bingCorroboration ? 1 : 0;
}

const WEIGHTS = {
  position: 0.28,
  demand: 0.22,
  ctrGap: 0.2,
  trend: 0.14,
  stability: 0.08,
  cannibalisation: 0.05,
  bing: 0.03,
};

export function computeOpportunityScore(
  input: OpportunityScoreInput,
): OpportunityScoreResult {
  const position = positionProximity(input.currentPosition);
  const demand = demandSignal(input.impressions);
  const ctrGap = ctrGapSignal(input.ctr, input.currentPosition);
  const trend = trendSignal(
    input.clicksChangePct,
    input.currentPosition,
    input.previousPosition,
  );
  const hasAnySignal = input.currentPosition != null || input.impressions > 0;
  const stability = stabilitySignal(input.positionStability, hasAnySignal);
  const cannibalisation = cannibalisationSignal(input.competingUrlCount);
  const bing = bingSignal(input.bingCorroboration);

  const factors: OpportunityFactor[] = [
    {
      key: "position",
      label: "Position proximity",
      value: position,
      weight: WEIGHTS.position,
      points: Math.round(position * WEIGHTS.position * 100),
      explanation:
        input.currentPosition == null
          ? "No current position data."
          : `Currently ranking #${input.currentPosition.toFixed(1)} - positions 4-15 have the most realistic upside.`,
    },
    {
      key: "demand",
      label: "Search demand",
      value: demand,
      weight: WEIGHTS.demand,
      points: Math.round(demand * WEIGHTS.demand * 100),
      explanation: `${input.impressions.toLocaleString()} impressions in the window - real, measured Google demand for this query.`,
    },
    {
      key: "ctrGap",
      label: "CTR gap",
      value: ctrGap,
      weight: WEIGHTS.ctrGap,
      points: Math.round(ctrGap * WEIGHTS.ctrGap * 100),
      explanation:
        input.ctr == null || input.currentPosition == null
          ? "No CTR data to compare."
          : `Actual CTR ${(input.ctr * 100).toFixed(1)}% vs a typical ~${(expectedCtrForPosition(input.currentPosition) * 100).toFixed(1)}% at this position - a gap suggests the title/snippet is underselling the click.`,
    },
    {
      key: "trend",
      label: "Trend / momentum",
      value: trend,
      weight: WEIGHTS.trend,
      points: Math.round(trend * WEIGHTS.trend * 100),
      explanation:
        input.clicksChangePct == null
          ? "Not enough history to compute a trend yet."
          : input.clicksChangePct >= 0
            ? `Clicks up ${input.clicksChangePct.toFixed(0)}% vs the previous period - worth reinforcing while it's moving.`
            : `Clicks down ${Math.abs(input.clicksChangePct).toFixed(0)}% vs the previous period - a recent, actionable decline.`,
    },
    {
      key: "stability",
      label: "Ranking stability",
      value: stability,
      weight: WEIGHTS.stability,
      points: Math.round(stability * WEIGHTS.stability * 100),
      explanation:
        input.positionStability == null
          ? "Not enough daily samples to judge stability."
          : `Position has varied by about ±${input.positionStability.toFixed(1)} day to day - ${input.positionStability < 5 ? "a stable, trustworthy signal" : "noisy, treat the average position as approximate"}.`,
    },
    {
      key: "cannibalisation",
      label: "Competing internal URLs",
      value: cannibalisation,
      weight: WEIGHTS.cannibalisation,
      points: Math.round(cannibalisation * WEIGHTS.cannibalisation * 100),
      explanation:
        input.competingUrlCount <= 1
          ? "One page owns this query - no cannibalisation risk detected."
          : `${input.competingUrlCount} different pages on this site received impressions for this query - likely cannibalisation worth resolving.`,
    },
    {
      key: "bing",
      label: "Bing corroboration",
      value: bing,
      weight: WEIGHTS.bing,
      points: Math.round(bing * WEIGHTS.bing * 100),
      explanation: bing
        ? "This query also shows meaningful Bing demand - a second, independent signal that the demand is real."
        : "No corroborating Bing data for this query (or Bing isn't connected for this site).",
    },
  ];

  const score = Math.max(
    0,
    Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.points, 0))),
  );

  return { score, factors };
}
