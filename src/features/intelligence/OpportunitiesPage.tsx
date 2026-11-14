import { useMemo, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { useSites } from "@/lib/hooks";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  useOpportunities,
  useRunIntel,
  useSetOpportunityStatus,
} from "./intel-api";
import { ProvenanceBadge, SitePicker } from "./Provenance";

const SOURCE_LABEL: Record<string, string> = {
  gsc: "Google Search Console",
  bing: "Bing Webmaster",
  ga4: "Google Analytics 4",
  neuronwriter: "NEURONwriter",
  ai_readiness: "AI readiness audit",
  ai_visibility: "AI visibility",
};

const EFFORT_TONE: Record<string, string> = {
  low: "text-success",
  medium: "text-warning",
  high: "text-critical",
};

export function OpportunitiesPage() {
  const sitesQuery = useSites();
  const oppsQuery = useOpportunities();
  const rebuild = useRunIntel("build-opportunities");
  const setStatus = useSetOpportunityStatus();
  const [siteId, setSiteId] = useState("");

  const sites = useMemo(
    () => (sitesQuery.data ?? []).filter((s) => s.is_active),
    [sitesQuery.data],
  );
  const siteName = (id: string) =>
    sites.find((s) => s.id === id)?.name ?? "Unknown site";
  const rows = (oppsQuery.data ?? []).filter(
    (o) => !siteId || o.site_id === siteId,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Opportunities</h1>
          <p className="text-sm text-muted-foreground">
            One queue built from your own Search Console, analytics,
            NEURONwriter and site-audit evidence. Every item cites its source
            and date. Impact figures are estimates, and nothing is published
            automatically.
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
          >
            <RefreshCw
              className={cn("h-4 w-4", rebuild.isPending && "animate-spin")}
              aria-hidden
            />
            Rebuild
          </Button>
        </div>
      </div>

      {rebuild.isError && (
        <p role="alert" className="text-sm text-critical">
          {(rebuild.error as Error).message}
        </p>
      )}

      {oppsQuery.isLoading ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No open opportunities"
          description="Run an AI readiness audit or wait for the next daily build. Items only appear when there is real evidence behind them."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((o) => (
            <li key={o.id}>
              <Card className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {siteName(o.site_id)}
                      {o.target_url
                        ? ` · ${o.target_url}`
                        : " · multiple or site-wide"}
                    </p>
                    <h2 className="text-sm font-semibold">{o.title}</h2>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-md border border-border px-2 py-0.5 font-medium">
                      Priority {o.priority}
                    </span>
                    <span className={cn("font-medium", EFFORT_TONE[o.effort])}>
                      {o.effort} effort
                    </span>
                  </div>
                </div>
                <dl className="grid gap-2 text-sm md:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Problem</dt>
                    <dd>{o.problem}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Proposed improvement
                    </dt>
                    <dd>{o.proposal}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                      Expected impact <ProvenanceBadge kind="estimate" />
                    </dt>
                    <dd>{o.expected_impact}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Evidence</dt>
                    <dd>
                      {SOURCE_LABEL[o.source] ?? o.source} · collected{" "}
                      {relativeTime(o.evidence_at)}
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {o.requires_publish_approval
                      ? "Needs your approval before anything is published."
                      : "No publishing involved."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() =>
                        setStatus.mutate({ id: o.id, status: "dismissed" })
                      }
                    >
                      <X className="h-4 w-4" aria-hidden /> Dismiss
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() =>
                        setStatus.mutate({ id: o.id, status: "done" })
                      }
                    >
                      <Check className="h-4 w-4" aria-hidden /> Mark done
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
