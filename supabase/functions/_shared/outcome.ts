// Before/after measurement for implemented opportunities. Pure functions: the
// caller supplies the stored baseline (28 days of the target page's Search
// Console numbers captured before the change) and a fresh 28-day window. No
// AI, no estimates dressed up as measurements: the verdict only reports what
// the numbers show and says when there is not enough data to judge.

export interface PageWindow {
  clicks: number;
  impressions: number;
  position: number | null;
}

export type OutcomeVerdict =
  | "improved"
  | "declined"
  | "no_clear_change"
  | "too_early";

export interface OutcomeResult {
  verdict: OutcomeVerdict;
  reason: string;
  daysSinceChange: number;
}

/** Search Console data lags, and a change needs time to be recrawled and
 * re-ranked, so judging earlier than this would be noise. */
export const MIN_DAYS_BEFORE_JUDGING = 14;

const pct = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n)}%`;

export function judgeOutcome(
  before: PageWindow,
  after: PageWindow,
  daysSinceChange: number,
): OutcomeResult {
  if (daysSinceChange < MIN_DAYS_BEFORE_JUDGING) {
    return {
      verdict: "too_early",
      daysSinceChange,
      reason: `Only ${daysSinceChange} day(s) since the change; Google needs at least ${MIN_DAYS_BEFORE_JUDGING} to recrawl and settle.`,
    };
  }
  if (before.impressions < 20 && after.impressions < 20) {
    return {
      verdict: "no_clear_change",
      daysSinceChange,
      reason:
        "Too few impressions before and after (under 20) to tell a real change from noise.",
    };
  }
  const clickChange =
    before.clicks > 0
      ? ((after.clicks - before.clicks) / before.clicks) * 100
      : after.clicks > 0
        ? 100
        : 0;
  const posDelta =
    before.position != null && after.position != null
      ? before.position - after.position // positive = moved up the results
      : null;
  const facts =
    `clicks ${before.clicks} → ${after.clicks} (${pct(clickChange)})` +
    (posDelta != null
      ? `, average position ${before.position} → ${after.position}`
      : "");
  const better =
    (clickChange >= 20 && after.clicks - before.clicks >= 3) ||
    (posDelta != null && posDelta >= 1 && after.impressions >= 20);
  const worse =
    (clickChange <= -20 && before.clicks - after.clicks >= 3) ||
    (posDelta != null && posDelta <= -1 && after.impressions >= 20);
  if (better && !worse) {
    return {
      verdict: "improved",
      daysSinceChange,
      reason: `Improved: ${facts}.`,
    };
  }
  if (worse && !better) {
    return {
      verdict: "declined",
      daysSinceChange,
      reason: `Declined: ${facts}.`,
    };
  }
  return {
    verdict: "no_clear_change",
    daysSinceChange,
    reason: `No clear change: ${facts}. Seasonality and demand shifts also move these numbers.`,
  };
}
