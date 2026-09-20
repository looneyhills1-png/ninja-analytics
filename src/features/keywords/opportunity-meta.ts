import type { OpportunityCategory } from "@/lib/keyword-opportunities";

export const CATEGORY_LABEL: Record<OpportunityCategory, string> = {
  "strike-now": "Strike now",
  "page-2": "Page 2",
  "high-impression-low-ctr": "Low CTR",
  rising: "Rising",
  falling: "Falling",
  new: "New",
  lost: "Lost",
  "ranking-url-changed": "URL changed",
  cannibalisation: "Cannibalisation",
  "wrong-page": "Possible mismatch",
  "content-decay": "Content decay",
};

export const CATEGORY_TONE: Record<OpportunityCategory, string> = {
  "strike-now": "border-primary/30 bg-primary/10 text-primary",
  "page-2": "border-warning/30 bg-warning/10 text-warning",
  "high-impression-low-ctr": "border-primary/30 bg-primary/10 text-primary",
  rising: "border-success/30 bg-success/10 text-success",
  falling: "border-critical/30 bg-critical/10 text-critical",
  new: "border-violet-500/30 bg-violet-500/10 text-violet-500",
  lost: "border-muted-foreground/30 bg-muted text-muted-foreground",
  "ranking-url-changed": "border-warning/30 bg-warning/10 text-warning",
  cannibalisation: "border-critical/30 bg-critical/10 text-critical",
  "wrong-page": "border-warning/30 bg-warning/10 text-warning",
  "content-decay": "border-critical/30 bg-critical/10 text-critical",
};

export const CATEGORY_ORDER: OpportunityCategory[] = [
  "strike-now",
  "page-2",
  "cannibalisation",
  "ranking-url-changed",
  "content-decay",
  "high-impression-low-ctr",
  "wrong-page",
  "falling",
  "rising",
  "new",
  "lost",
];

export const RANGES = [7, 28, 90] as const;
