import { useMemo, useState } from "react";
import { PlayCircle } from "lucide-react";
import { useSites } from "@/lib/hooks";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useLatestReadiness, useRunIntel } from "./intel-api";
import { SitePicker } from "./Provenance";

const SEVERITY_TONE: Record<string, string> = {
  error: "border-critical/30 bg-critical/10 text-critical",
  warning: "border-warning/30 bg-warning/10 text-warning",
  notice: "border-border text-muted-foreground",
  ok: "border-success/30 bg-success/10 text-success",
};

export function AiReadinessPage() {
  const sitesQuery = useSites();
  const sites = useMemo(
    () => (sitesQuery.data ?? []).filter((s) => s.is_active),
    [sitesQuery.data],
  );
  const [picked, setPicked] = useState("");
  const siteId =
    picked && sites.some((s) => s.id === picked)
      ? picked
      : (sites[0]?.id ?? "");
  const readiness = useLatestReadiness(siteId);
  const audit = useRunIntel("ai-readiness-audit");

  const findings = readiness.data?.findings ?? [];
  const crawlers = findings.filter((f) => f.check_key.startsWith("crawler_"));
  const issues = findings
    .filter((f) => f.severity !== "ok" && !f.check_key.startsWith("crawler_"))
    .sort(
      (a, b) =>
        ["error", "warning", "notice"].indexOf(a.severity) -
        ["error", "warning", "notice"].indexOf(b.severity),
    );
  const run = readiness.data?.run;
  const skipped = (
    audit.data?.results as Array<{ skipped?: string }> | undefined
  )?.[0]?.skipped;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">AI Readiness</h1>
          <p className="text-sm text-muted-foreground">
            Bounded technical checks of your own site: crawler access, sitemap,
            indexability, canonicals, structured data and answer-friendly
            structure. At most 15 pages per site per run, weekly or on demand.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SitePicker sites={sites} value={siteId} onChange={setPicked} />
          <Button
            variant="secondary"
            size="sm"
            disabled={audit.isPending || !siteId}
            onClick={() => audit.mutate({ siteId })}
          >
            <PlayCircle className="h-4 w-4" aria-hidden />
            {audit.isPending ? "Auditing…" : "Run audit"}
          </Button>
        </div>
      </div>

      {audit.isError && (
        <p role="alert" className="text-sm text-critical">
          {(audit.error as Error).message}
        </p>
      )}
      {skipped === "recent_run" && (
        <p className="text-sm text-muted-foreground">
          A run finished in the last 10 minutes, so no new audit was started.
        </p>
      )}

      {readiness.isLoading ? (
        <Skeleton className="h-64" />
      ) : !run ? (
        <EmptyState
          title="No audit yet"
          description="Run an audit to check robots.txt, sitemap, indexability and structured data for this site."
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Last audit {relativeTime(run.started_at)} · {run.status} ·{" "}
            {run.pages_checked} page(s) checked
          </p>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">
              Crawler access (robots.txt)
            </h2>
            {crawlers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No crawler rules were evaluated (see issues below).
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {crawlers.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span>
                      {String(
                        (f.evidence as { crawler?: string })?.crawler ??
                          f.check_key,
                      )}
                    </span>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                        SEVERITY_TONE[f.severity],
                      )}
                      title={f.message}
                    >
                      {f.severity === "ok"
                        ? "Allowed"
                        : f.severity === "error"
                          ? "Blocked"
                          : "Blocked (your choice)"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">
              Issues ({issues.length})
            </h2>
            {issues.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No issues found in the sampled pages.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {issues.map((f) => (
                  <li
                    key={f.id}
                    className="flex flex-wrap items-start gap-3 py-2 text-sm"
                  >
                    <span
                      className={cn(
                        "mt-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                        SEVERITY_TONE[f.severity],
                      )}
                    >
                      {f.severity}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p>{f.message}</p>
                      {f.url && (
                        <p className="truncate text-xs text-muted-foreground">
                          {f.url}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
