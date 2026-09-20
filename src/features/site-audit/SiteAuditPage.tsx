import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Play, ShieldCheck } from "lucide-react";
import {
  useSiteAuditIssues,
  useSiteAuditPages,
  useSiteAuditRuns,
  useSites,
  useTriggerSiteAudit,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber } from "@/lib/format";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { SiteAuditIssue } from "@/types/database";

type Severity = SiteAuditIssue["severity"];

function healthTone(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 80) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-critical";
}

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/**
 * Site Audit (CLAUDE.md Phase 5) - an on-demand, bounded crawl of one of our
 * own sites (never a competitor's). Health Score is an explainable, flat
 * deduction per issue (see site-crawler.ts's computeHealthScore) - never a
 * vendor's proprietary "site health" metric.
 */
export function SiteAuditPage() {
  const privacy = usePrivacyMode();
  const sitesQuery = useSites();
  const [params, setParams] = useSearchParams();
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const sites = (sitesQuery.data ?? []).filter((s) => s.is_active);
  const siteId =
    params.get("site") && sites.some((s) => s.id === params.get("site"))
      ? (params.get("site") as string)
      : (sites[0]?.id ?? "");

  function setSite(id: string) {
    const next = new URLSearchParams(params);
    next.set("site", id);
    setParams(next, { replace: true });
    setSelectedRunId(null);
  }

  const runsQuery = useSiteAuditRuns(siteId);
  const auditMutation = useTriggerSiteAudit(siteId);
  const runs = runsQuery.data ?? [];
  const activeRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null;

  const issuesQuery = useSiteAuditIssues(activeRun?.id ?? "");
  const pagesQuery = useSiteAuditPages(activeRun?.id ?? "");

  const issues = useMemo(() => issuesQuery.data ?? [], [issuesQuery.data]);
  const filteredIssues = useMemo(
    () =>
      severityFilter === "all"
        ? issues
        : issues.filter((i) => i.severity === severityFilter),
    [issues, severityFilter],
  );

  if (sitesQuery.isLoading) return <Skeleton className="h-64" />;
  if (sites.length === 0) {
    return (
      <EmptyState
        title="No sites yet"
        description="Add a website in Sites before a site audit has anything to crawl."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Site Audit</h1>
          <p className="text-sm text-muted-foreground">
            A bounded crawl of this site's own pages - broken links, redirects,
            indexability, on-page and technical checks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={siteId}
            onChange={(e) => setSite(e.target.value)}
            className="h-9 rounded-md border border-border bg-card px-2 text-sm"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            loading={auditMutation.isPending}
            onClick={() => void auditMutation.mutate()}
          >
            <Play className="h-3.5 w-3.5" /> Run audit
          </Button>
        </div>
      </div>
      {auditMutation.error && (
        <p className="text-xs text-critical">
          {auditMutation.error instanceof Error
            ? auditMutation.error.message
            : "Could not run the audit."}
        </p>
      )}

      {runsQuery.isLoading ? (
        <Skeleton className="h-40" />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No audit run yet"
          description="Click Run audit to crawl this site for the first time."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={activeRun?.id ?? ""}
              onChange={(e) => setSelectedRunId(e.target.value)}
              className="h-9 rounded-md border border-border bg-card px-2 text-sm"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {relativeTime(r.started_at)} &middot; {r.status}
                </option>
              ))}
            </select>
          </div>

          {activeRun && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Card>
                <div className="p-4">
                  <p className="text-xs font-medium text-muted-foreground">
                    Health Score
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-3xl font-bold tabular-nums",
                      healthTone(activeRun.health_score),
                    )}
                  >
                    {activeRun.health_score ?? "-"}
                  </p>
                </div>
              </Card>
              <StatCard
                label="Errors"
                value={formatNumber(activeRun.errors_count)}
              />
              <StatCard
                label="Warnings"
                value={formatNumber(activeRun.warnings_count)}
              />
              <StatCard
                label="Notices"
                value={formatNumber(activeRun.notices_count)}
              />
              <StatCard
                label="Pages crawled"
                value={formatNumber(activeRun.pages_crawled)}
                hint={
                  activeRun.status === "failed"
                    ? (activeRun.error_message ?? "Run failed")
                    : undefined
                }
              />
            </div>
          )}

          {activeRun && (
            <>
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Issues</h2>
                  <div className="flex gap-1">
                    {(["all", "error", "warning", "notice"] as const).map(
                      (s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setSeverityFilter(s)}
                          className={cn(
                            "rounded border px-2 py-1 text-xs font-medium capitalize",
                            severityFilter === s
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {s}{" "}
                          {s !== "all" &&
                            `(${issues.filter((i) => i.severity === s).length})`}
                        </button>
                      ),
                    )}
                  </div>
                </div>
                {issuesQuery.isLoading ? (
                  <Skeleton className="h-48" />
                ) : filteredIssues.length === 0 ? (
                  <EmptyState title="No issues at this severity" />
                ) : (
                  <Card>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="px-3 py-2 font-medium">Severity</th>
                            <th className="px-2 py-2 font-medium">Category</th>
                            <th className="px-2 py-2 font-medium">Issue</th>
                            <th className="px-2 py-2 font-medium">URL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredIssues.slice(0, 300).map((issue) => (
                            <tr
                              key={issue.id}
                              className="border-b border-border last:border-0"
                            >
                              <td className="px-3 py-2">
                                <span
                                  className={cn(
                                    "rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize",
                                    issue.severity === "error" &&
                                      "border-critical/30 bg-critical/10 text-critical",
                                    issue.severity === "warning" &&
                                      "border-warning/30 bg-warning/10 text-warning",
                                    issue.severity === "notice" &&
                                      "border-border text-muted-foreground",
                                  )}
                                >
                                  {issue.severity}
                                </span>
                              </td>
                              <td className="px-2 py-2 text-xs text-muted-foreground">
                                {issue.category}
                              </td>
                              <td className="max-w-[24rem] px-2 py-2">
                                {issue.message}
                              </td>
                              <td className="max-w-[14rem] truncate px-2 py-2 text-xs text-muted-foreground">
                                {issue.url
                                  ? privacy.enabled
                                    ? privacy.maskText(
                                        issue.url,
                                        `audit-issue:${issue.id}`,
                                      )
                                    : shortPath(issue.url)
                                  : "Site-wide"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </section>

              <section className="space-y-3">
                <h2 className="text-sm font-semibold">Pages crawled</h2>
                {pagesQuery.isLoading ? (
                  <Skeleton className="h-48" />
                ) : (pagesQuery.data ?? []).length === 0 ? (
                  <EmptyState title="No pages recorded for this run" />
                ) : (
                  <Card>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="px-3 py-2 font-medium">URL</th>
                            <th className="px-2 py-2 text-right font-medium">
                              Status
                            </th>
                            <th className="px-2 py-2 font-medium">Title</th>
                            <th className="px-2 py-2 text-right font-medium">
                              Words
                            </th>
                            <th className="px-2 py-2 text-right font-medium">
                              H1
                            </th>
                            <th className="px-2 py-2 text-right font-medium">
                              Depth
                            </th>
                            <th className="px-2 py-2 font-medium">Flags</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(pagesQuery.data ?? []).slice(0, 300).map((page) => (
                            <tr
                              key={page.id}
                              className="border-b border-border last:border-0"
                            >
                              <td className="max-w-[16rem] truncate px-3 py-2">
                                {privacy.enabled
                                  ? privacy.maskText(
                                      page.url,
                                      `audit-page:${page.id}`,
                                    )
                                  : shortPath(page.url)}
                              </td>
                              <td
                                className={cn(
                                  "px-2 py-2 text-right tabular-nums",
                                  page.status_code != null &&
                                    page.status_code >= 400
                                    ? "text-critical"
                                    : "text-muted-foreground",
                                )}
                              >
                                {page.status_code ?? "-"}
                              </td>
                              <td className="max-w-[12rem] truncate px-2 py-2 text-xs text-muted-foreground">
                                {page.title
                                  ? privacy.maskText(
                                      page.title,
                                      `audit-title:${page.id}`,
                                    )
                                  : "-"}
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                {page.word_count ?? "-"}
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                {page.h1_count ?? "-"}
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                {page.crawl_depth != null &&
                                page.crawl_depth >= 0
                                  ? page.crawl_depth
                                  : "-"}
                              </td>
                              <td className="px-2 py-2">
                                <div className="flex flex-wrap gap-1 text-[10px]">
                                  {page.meta_robots_noindex && (
                                    <span className="rounded border border-warning/30 bg-warning/10 px-1 text-warning">
                                      noindex
                                    </span>
                                  )}
                                  {!page.has_viewport_meta && (
                                    <span className="rounded border border-critical/30 bg-critical/10 px-1 text-critical">
                                      no viewport
                                    </span>
                                  )}
                                  {page.has_schema && (
                                    <span className="rounded border border-success/30 bg-success/10 px-1 text-success">
                                      schema
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
