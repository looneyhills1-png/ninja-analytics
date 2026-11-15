import { describe, expect, it } from "vitest";
import { topActions } from "@/lib/top-actions";
import type { OpportunityRow } from "@/types/database";

const row = (o: Partial<OpportunityRow>) =>
  ({
    id: Math.random().toString(),
    status: "validated",
    classification: "content_improvement",
    priority: 50,
    ...o,
  }) as OpportunityRow;

describe("topActions", () => {
  it("returns the three highest-priority actionable items", () => {
    const rows = [10, 90, 70, 30, 80].map((p) => row({ priority: p }));
    expect(topActions(rows).map((r) => r.priority)).toEqual([90, 80, 70]);
  });
  it("skips monitor, rejected and finished items", () => {
    const rows = [
      row({ classification: "monitor", priority: 99 }),
      row({ status: "rejected", priority: 98 }),
      row({ status: "monitoring", priority: 97 }),
      row({ status: "implemented", priority: 96 }),
      row({ priority: 5 }),
    ];
    expect(topActions(rows)).toHaveLength(1);
  });
  it("does not surface unvalidated (unclassified) items", () => {
    expect(topActions([row({ classification: null })])).toHaveLength(0);
  });
});
