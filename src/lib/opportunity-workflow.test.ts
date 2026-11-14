import { describe, expect, it } from "vitest";
import {
  actionLabel,
  approvalState,
  countByStatus,
  describeSnapshot,
  readSnapshot,
  STATUS_ORDER,
  TRANSITIONS,
} from "./opportunity-workflow";

describe("workflow transitions", () => {
  it("cannot jump straight from New to Approved or Implemented", () => {
    expect(TRANSITIONS.new).not.toContain("approved");
    expect(TRANSITIONS.new).not.toContain("implemented");
    expect(TRANSITIONS.validated).toContain("approved");
    expect(TRANSITIONS.approved).toContain("implemented");
  });

  it("every status can eventually be reopened or progressed (no dead ends)", () => {
    for (const s of STATUS_ORDER)
      expect(TRANSITIONS[s].length).toBeGreaterThan(0);
    expect(TRANSITIONS.rejected).toEqual(["new"]);
  });

  it("labels owner decisions clearly", () => {
    expect(actionLabel("validated", "approved")).toBe(
      "Approve for implementation",
    );
    expect(actionLabel("rejected", "new")).toBe("Reopen");
    expect(actionLabel("new", "monitoring")).toBe("Move to Monitoring");
  });
});

describe("approvalState", () => {
  it("only approved and implemented items count as owner-approved", () => {
    expect(approvalState("approved", true).approved).toBe(true);
    expect(approvalState("implemented", true).approved).toBe(true);
    expect(approvalState("validated", true)).toMatchObject({ approved: false });
    expect(approvalState("validated", true).label).toContain(
      "nothing will be published",
    );
    expect(approvalState("new", false).approved).toBe(true);
  });
});

describe("snapshots", () => {
  it("reads a baseline and rejects anything else", () => {
    const s = readSnapshot({
      capturedAt: "2026-11-14T10:00:00Z",
      dataThrough: "2026-11-10",
      clicks: 26,
      impressions: 900,
      position: 7.2,
    });
    expect(s).not.toBeNull();
    expect(describeSnapshot(s!)).toBe(
      "26 clicks · 900 impressions · avg position 7.2 (28 days to 2026-11-10)",
    );
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot({ foo: 1 })).toBeNull();
  });
});

describe("countByStatus", () => {
  it("counts every status including empty ones", () => {
    const c = countByStatus([
      { status: "new" },
      { status: "new" },
      { status: "rejected" },
    ]);
    expect(c.new).toBe(2);
    expect(c.rejected).toBe(1);
    expect(c.approved).toBe(0);
  });
});
