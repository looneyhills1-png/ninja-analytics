import type { OpportunityCategory } from "@/lib/keyword-opportunities";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  CATEGORY_TONE,
} from "@/features/keywords/opportunity-meta";
import { cn } from "@/lib/utils";

export function OpportunityBadge({
  category,
}: {
  category: OpportunityCategory;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium",
        CATEGORY_TONE[category],
      )}
    >
      {CATEGORY_LABEL[category]}
    </span>
  );
}

/** Sorted by the same priority order used to pick the recommended action, so
 * the most important badge always reads first. */
export function OpportunityBadgeList({
  categories,
  max,
}: {
  categories: OpportunityCategory[];
  max?: number;
}) {
  const sorted = [...categories].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
  );
  const shown = max ? sorted.slice(0, max) : sorted;
  const hidden = sorted.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((c) => (
        <OpportunityBadge key={c} category={c} />
      ))}
      {hidden > 0 && (
        <span className="text-[10px] text-muted-foreground">+{hidden}</span>
      )}
    </div>
  );
}
