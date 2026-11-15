import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useSites } from "@/lib/hooks";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  actionLabel,
  approvalState,
  CHANGE_TYPE_LABEL,
  CLASSIFICATION_LABEL,
  countByStatus,
  describeSnapshot,
  readSnapshot,
  STATUS_LABEL,
  STATUS_ORDER,
  TRANSITIONS,
} from "@/lib/opportunity-workflow";
import type { OpportunityRow, OpportunityStatus } from "@/types/database";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  useOpportunities,
  useOpportunityHistory,
  useRunIntel,
  useSaveOwnerNote,
  useTransitionOpportunity,
} from "./intel-api";
import { ProvenanceBadge, SitePicker } from "./Provenance";
import { FixPromptModal } from "@/features/keywords/FixPromptModal";
import { buildOpportunityFixPrompt } from "@/features/keywords/generateFixPrompt";

const SOURCE_LABEL: Record<string, string> = {
  gsc: "Google Search Console",
  bing: "Bing Webmaster",
  ga4: "Google Analytics 4",
  neuronwriter: "NEURONwriter",
  ai_readiness: "AI readiness audit",
  ai_visibility: "AI visibility",
};

const CLASS_TONE: Record<string, string> = {
  fix_now: "border-critical/30 bg-critical/10 text-critical",
  content_improvement: "border-primary/30 bg-primary/10 text-primary",
  new_content: "border-warning/30 bg-warning/10 text-warning",
  monitor: "border-border text-muted-foreground",
  reject: "border-border text-muted-foreground",
};

const EFFORT_TONE: Record<string, string> = {
  low: "text-success",
  medium: "text-warning",
  high: "text-critical",
};

export function OpportunitiesPage() {
  const sitesQuery = useSites();
  const oppsQuery = useOpportunities();
  const validate = useRunIntel("validate-opportunities");
  const rebuild = useRunIntel("build-opportunities");
  const [siteId, setSiteId] = useState("");
  const [status, setStatus] = useState<OpportunityStatus>("validated");

  const sites = useMemo(
    () => (sitesQuery.data ?? []).filter((s) => s.is_active),
    [sitesQuery.data],
  );
  const siteOf = (id: string) => {
    const s = sites.find((x) => x.id === id);
    return { name: s?.name ?? "Unknown site", domain: s?.domain ?? "" };
  };
  const inSite = (oppsQuery.data ?? []).filter(
    (o) => !siteId || o.site_id === siteId,
  );
  const counts = countByStatus(inSite);
  const rows = inSite.filter((o) => o.status === status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Opportunities</h1>
          <p className="text-sm text-muted-foreground">
            One queue built from your own Search Console, analytics,
            NEURONwriter and site-audit evidence, checked against the live
            pages. Every item keeps its history. Impact figures are estimates.
            Nothing is ever published or changed on a website by Ninja
            Analytics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SitePicker
            sites={sites}
            value={siteId}
            onChange={setSiteId}
            allowAll
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate({})}
            title="Refresh evidence and add new findings"
          >
            <RefreshCw
              className={cn("h-4 w-4", rebuild.isPending && "animate-spin")}
              aria-hidden
            />
            Rebuild
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={validate.isPending}
            onClick={() => validate.mutate({})}
            title="Check the actual pages and first-party demand (no AI, no paid calls)"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {validate.isPending ? "Validating…" : "Validate"}
          </Button>
        </div>
      </div>

      {(rebuild.isError || validate.isError) && (
        <p role="alert" className="text-sm text-critical">
          {((rebuild.error ?? validate.error) as Error).message}
        </p>
      )}

      <nav
        className="flex flex-wrap gap-1 border-b border-border"
        aria-label="Workflow status"
      >
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={cn(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              status === s
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {STATUS_LABEL[s]} <span className="text-xs">({counts[s]})</span>
          </button>
        ))}
      </nav>

      {oppsQuery.isLoading ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={`Nothing in ${STATUS_LABEL[status]}`}
          description="Items move through New, Validated, Approved, Implemented and Monitoring as they are reviewed. Rejected items stay here with their reasons."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((o) => (
            <li key={o.id}>
              <OpportunityCard opp={o} site={siteOf(o.site_id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpportunityCard({
  opp,
  site,
}: {
  opp: OpportunityRow;
  site: { name: string; domain: string };
}) {
  const [open, setOpen] = useState(false);
  const [showFix, setShowFix] = useState(false);
  const [note, setNote] = useState("");
  const transition = useTransitionOpportunity();
  const saveNote = useSaveOwnerNote();
  const history = useOpportunityHistory(opp.id, open);
  const approval = approvalState(opp.status, opp.requires_publish_approval);
  const baseline = readSnapshot(opp.baseline);
  const after = readSnapshot(opp.after_metrics);
  const latestReview = history.data?.reviews.at(-1);
  const outcome =
    opp.after_metrics &&
    typeof opp.after_metrics === "object" &&
    "reason" in opp.after_metrics &&
    typeof (opp.after_metrics as { reason?: unknown }).reason === "string"
      ? (opp.after_metrics as { reason: string }).reason
      : null;
  const wasPriority =
    opp.original_priority != null && opp.original_priority !== opp.priority
      ? opp.original_priority
      : null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {site.name}
            {opp.target_url
              ? ` · ${opp.target_url}`
              : " · multiple or site-wide"}
          </p>
          <h2 className="text-sm font-semibold">{opp.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {opp.classification && (
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 font-medium",
                CLASS_TONE[opp.classification],
              )}
            >
              {CLASSIFICATION_LABEL[opp.classification]}
            </span>
          )}
          <span className="rounded-md border border-border px-2 py-0.5 font-medium">
            Priority {opp.priority}
            {wasPriority != null && (
              <span className="font-normal text-muted-foreground">
                {" "}
                (was {wasPriority})
              </span>
            )}
          </span>
          <span className={cn("font-medium", EFFORT_TONE[opp.effort])}>
            {opp.effort} effort
          </span>
        </div>
      </div>

      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Problem</dt>
          <dd>{opp.problem}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            Recommended change
            {opp.change_type && ` · ${CHANGE_TYPE_LABEL[opp.change_type]}`}
          </dt>
          <dd className="whitespace-pre-line">
            {opp.recommended_change ??
              (opp.classification ? "No change recommended." : opp.proposal)}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-2 text-xs text-muted-foreground">
            Expected benefit <ProvenanceBadge kind="estimate" />
          </dt>
          <dd>{opp.expected_impact}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Evidence</dt>
          <dd>
            {SOURCE_LABEL[opp.source] ?? opp.source} · collected{" "}
            {relativeTime(opp.evidence_at)}
            {opp.reviewed_at && (
              <> · validated {relativeTime(opp.reviewed_at)}</>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            Baseline before any change
          </dt>
          <dd>
            {baseline
              ? describeSnapshot(baseline)
              : "No page-level baseline (no single target page)."}
            {after && (
              <span className="block text-muted-foreground">
                After: {describeSnapshot(after)}
                {outcome && (
                  <span className="block font-medium text-foreground">
                    Result: {outcome}
                  </span>
                )}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Owner approval</dt>
          <dd className={approval.approved ? "text-success" : undefined}>
            {approval.label}
          </dd>
        </div>
      </dl>

      {transition.isError && (
        <p role="alert" className="text-sm text-critical">
          {(transition.error as Error).message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for the history"
          aria-label="Note for the history"
          className="h-8 min-w-[12rem] flex-1 rounded-md border border-border bg-card px-2 text-sm"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setShowFix(true)}
          title="Generate a ready-to-use fix prompt for this item. Nothing is edited or published."
        >
          Fix
        </Button>
        {TRANSITIONS[opp.status].map((to) => (
          <Button
            key={to}
            size="sm"
            variant={
              to === "approved" || to === "implemented"
                ? "primary"
                : "secondary"
            }
            disabled={transition.isPending}
            onClick={() => {
              transition.mutate({ id: opp.id, status: to, note });
              setNote("");
            }}
          >
            {actionLabel(opp.status, to)}
          </Button>
        ))}
      </div>

      {showFix && (
        <FixPromptModal
          title={`${site.name} - ${opp.title}`}
          prompt={buildOpportunityFixPrompt({
            siteName: site.name,
            siteDomain: site.domain,
            status: opp.status,
            classification: opp.classification,
            changeType: opp.change_type,
            targetUrl: opp.target_url,
            title: opp.title,
            problem: opp.problem,
            recommendedChange: opp.recommended_change,
            proposal: opp.proposal,
            expectedImpact: opp.expected_impact,
            evidence: opp.evidence,
            baselineText: baseline ? describeSnapshot(baseline) : null,
            requiresPublishApproval: opp.requires_publish_approval,
            ownerNote: opp.owner_note,
          })}
          onClose={() => setShowFix(false)}
        />
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium text-primary"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        Review reasoning and history
      </button>

      {open && (
        <div className="space-y-3 rounded-md border border-border p-3 text-sm">
          {history.isLoading ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Latest review
                </p>
                {latestReview ? (
                  <p>
                    <span className="font-medium">
                      {CLASSIFICATION_LABEL[latestReview.classification]}
                    </span>
                    : {latestReview.reasoning}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({latestReview.rules_version},{" "}
                      {relativeTime(latestReview.reviewed_at)}; reviews are
                      kept, not overwritten)
                    </span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Not validated yet. Press Validate.
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Original finding (preserved)
                </p>
                <p className="text-muted-foreground">
                  {opp.proposal} · original priority{" "}
                  {opp.original_priority ?? opp.priority}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  History
                </p>
                <ol className="space-y-0.5">
                  {(history.data?.events ?? []).map((e) => (
                    <li key={e.id}>
                      <span className="text-xs text-muted-foreground">
                        {new Date(e.at).toLocaleString()} · {e.actor}
                      </span>{" "}
                      {e.from_status ? `${e.from_status} → ` : ""}
                      {e.to_status}
                      {e.note ? ` — ${e.note}` : ""}
                    </li>
                  ))}
                </ol>
              </div>
              <input
                defaultValue={opp.owner_note ?? ""}
                onBlur={(e) => {
                  if (e.target.value !== (opp.owner_note ?? "")) {
                    saveNote.mutate({ id: opp.id, note: e.target.value });
                  }
                }}
                placeholder="Your private note"
                aria-label="Owner note"
                className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm"
              />
            </>
          )}
        </div>
      )}
    </Card>
  );
}
