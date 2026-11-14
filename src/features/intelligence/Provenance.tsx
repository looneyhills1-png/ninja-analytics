import { cn } from "@/lib/utils";

export type ProvenanceKind =
  | "verified"
  | "measured"
  | "sampled"
  | "estimate"
  | "manual"
  | "unsupported";

const STYLE: Record<
  ProvenanceKind,
  { label: string; cls: string; hint: string }
> = {
  verified: {
    label: "Verified",
    cls: "border-success/30 bg-success/10 text-success",
    hint: "Returned by an official first-party API.",
  },
  measured: {
    label: "Measured",
    cls: "border-success/30 bg-success/10 text-success",
    hint: "Counted from your own analytics.",
  },
  sampled: {
    label: "Sampled observation",
    cls: "border-warning/30 bg-warning/10 text-warning",
    hint: "A spot check. Not platform-wide impressions, ranking or share of voice.",
  },
  estimate: {
    label: "Estimate",
    cls: "border-border text-muted-foreground",
    hint: "A judgement, not a measured result.",
  },
  manual: {
    label: "Manual import",
    cls: "border-border text-muted-foreground",
    hint: "Entered by hand from the provider's own report.",
  },
  unsupported: {
    label: "No API",
    cls: "border-critical/30 bg-critical/10 text-critical",
    hint: "The provider offers no documented API; nothing is collected automatically.",
  },
};

export function ProvenanceBadge({
  kind,
  className,
}: {
  kind: ProvenanceKind;
  className?: string;
}) {
  const s = STYLE[kind];
  return (
    <span
      title={s.hint}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.cls,
        className,
      )}
    >
      {s.label}
    </span>
  );
}

export function SitePicker({
  sites,
  value,
  onChange,
  allowAll,
}: {
  sites: Array<{ id: string; name: string }>;
  value: string;
  onChange: (id: string) => void;
  allowAll?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-border bg-card px-2 text-sm"
      aria-label="Site"
    >
      {allowAll && <option value="">All sites</option>}
      {sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
