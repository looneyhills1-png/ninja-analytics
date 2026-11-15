import type { OpportunityRow } from "@/types/database";

/** Items worth acting on: still open, validated as a real change, ranked by
 * priority. Monitor/reject classifications and finished work are excluded. */
export function topActions(
  rows: OpportunityRow[],
  limit = 3,
): OpportunityRow[] {
  return rows
    .filter(
      (o) =>
        ["new", "validated", "approved"].includes(o.status) &&
        (o.classification === "fix_now" ||
          o.classification === "content_improvement" ||
          o.classification === "new_content"),
    )
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}
