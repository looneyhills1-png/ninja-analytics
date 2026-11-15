import { describe, expect, it } from "vitest";
import {
  judgeOutcome,
  MIN_DAYS_BEFORE_JUDGING,
} from "../../supabase/functions/_shared/outcome";

const before = { clicks: 26, impressions: 900, position: 6.1 };

describe("judgeOutcome", () => {
  it("refuses to judge too early", () => {
    const r = judgeOutcome(before, before, MIN_DAYS_BEFORE_JUDGING - 1);
    expect(r.verdict).toBe("too_early");
  });
  it("reports an improvement from clicks", () => {
    const r = judgeOutcome(
      before,
      { clicks: 40, impressions: 950, position: 6 },
      30,
    );
    expect(r.verdict).toBe("improved");
    expect(r.reason).toContain("26 → 40");
  });
  it("reports an improvement from position alone", () => {
    const r = judgeOutcome(
      before,
      { clicks: 27, impressions: 900, position: 4.8 },
      20,
    );
    expect(r.verdict).toBe("improved");
  });
  it("reports a decline", () => {
    const r = judgeOutcome(
      before,
      { clicks: 3, impressions: 900, position: 9.2 },
      40,
    );
    expect(r.verdict).toBe("declined");
  });
  it("says no clear change for small moves", () => {
    const r = judgeOutcome(
      before,
      { clicks: 28, impressions: 880, position: 6.0 },
      30,
    );
    expect(r.verdict).toBe("no_clear_change");
  });
  it("does not judge noise on tiny volumes", () => {
    const r = judgeOutcome(
      { clicks: 0, impressions: 4, position: 20 },
      { clicks: 1, impressions: 6, position: 12 },
      30,
    );
    expect(r.verdict).toBe("no_clear_change");
    expect(r.reason).toContain("Too few impressions");
  });
});
