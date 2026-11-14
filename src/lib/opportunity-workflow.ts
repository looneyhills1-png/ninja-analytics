// Client-side view of the opportunity workflow. The database trigger
// (0025_opportunity_workflow.sql) is the authority; this mirrors its allowed
// transitions only so the UI can show valid actions.

import type {
  OpportunityClassification,
  OpportunityStatus,
} from "@/types/database";

export const STATUS_ORDER: OpportunityStatus[] = [
  "new",
  "validated",
  "approved",
  "implemented",
  "monitoring",
  "rejected",
];

export const STATUS_LABEL: Record<OpportunityStatus, string> = {
  new: "New",
  validated: "Validated",
  approved: "Approved",
  implemented: "Implemented",
  monitoring: "Monitoring",
  rejected: "Rejected",
};

export const TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  new: ["validated", "rejected", "monitoring"],
  validated: ["approved", "rejected", "monitoring", "new"],
  approved: ["implemented", "validated", "rejected", "monitoring"],
  implemented: ["monitoring", "new"],
  monitoring: ["implemented", "new", "validated", "rejected"],
  rejected: ["new"],
};

const ACTION_LABEL: Partial<
  Record<OpportunityStatus, Partial<Record<OpportunityStatus, string>>>
> = {
  validated: { approved: "Approve for implementation" },
  approved: { implemented: "Mark implemented" },
  implemented: { monitoring: "Start monitoring", new: "Reopen (regressed)" },
  rejected: { new: "Reopen" },
};

export function actionLabel(
  from: OpportunityStatus,
  to: OpportunityStatus,
): string {
  return ACTION_LABEL[from]?.[to] ?? `Move to ${STATUS_LABEL[to]}`;
}

export const CLASSIFICATION_LABEL: Record<OpportunityClassification, string> = {
  fix_now: "Fix now",
  content_improvement: "Content improvement",
  new_content: "New content",
  monitor: "Monitor",
  reject: "Reject",
};

export const CHANGE_TYPE_LABEL = {
  edit: "Edit an existing page",
  new_page: "Create a new page",
  technical: "Technical fix",
} as const;

/** Whether the owner has signed off on making a change. Nothing is ever
 * published by Ninja Analytics; this only records the owner's decision. */
export function approvalState(
  status: OpportunityStatus,
  requiresApproval: boolean,
): { label: string; approved: boolean } {
  if (!requiresApproval) {
    return { label: "No publishing involved", approved: true };
  }
  if (status === "approved" || status === "implemented") {
    return { label: "Approved by owner", approved: true };
  }
  if (status === "rejected") {
    return { label: "Rejected, nothing will be changed", approved: false };
  }
  return {
    label: "Awaiting owner approval, nothing will be published",
    approved: false,
  };
}

export interface MetricSnapshot {
  capturedAt?: string;
  dataThrough?: string;
  url?: string;
  clicks?: number;
  impressions?: number;
  position?: number | null;
}

export function readSnapshot(value: unknown): MetricSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  if (num(o.clicks) === undefined && num(o.impressions) === undefined) {
    return null;
  }
  return {
    capturedAt: typeof o.capturedAt === "string" ? o.capturedAt : undefined,
    dataThrough: typeof o.dataThrough === "string" ? o.dataThrough : undefined,
    url: typeof o.url === "string" ? o.url : undefined,
    clicks: num(o.clicks),
    impressions: num(o.impressions),
    position: typeof o.position === "number" ? o.position : null,
  };
}

export function describeSnapshot(s: MetricSnapshot): string {
  const parts = [
    `${s.clicks ?? 0} clicks`,
    `${s.impressions ?? 0} impressions`,
    s.position != null ? `avg position ${s.position}` : "no position data",
  ];
  return `${parts.join(" · ")}${s.dataThrough ? ` (28 days to ${s.dataThrough})` : ""}`;
}

export function countByStatus(
  rows: Array<{ status: OpportunityStatus }>,
): Record<OpportunityStatus, number> {
  const out = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<
    OpportunityStatus,
    number
  >;
  for (const r of rows) out[r.status] += 1;
  return out;
}
