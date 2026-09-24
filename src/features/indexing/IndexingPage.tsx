import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Copy,
  ExternalLink,
  RefreshCw,
  SearchCheck,
  ChevronDown,
} from "lucide-react";
import {
  useKeywordOpportunities,
  useLatestSiteAuditPages,
  useSiteLastmods,
  useSites,
  useTriggerUrlInspection,
  useUrlInspectionHistory,
  useUrlInspections,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber, formatPosition } from "@/lib/format";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  buildIndexingCandidates,
  summarizeIndexingCandidates,
  summaryBucketFor,
  type IndexingCandidate,
  type IndexingSummaryBucket,
} from "@/features/indexing/indexing-priority";
import type { UrlInspection, UrlInspectionHistory } from "@/types/database";

const DAYS = 28;
const MAX_BATCH = 10;
const ACTION_QUEUE_SIZE = 8;

const BUCKET_LABELS: Record<IndexingSummaryBucket, string> = {
  indexed: "Indexed",
  not_indexed: "Not indexed",
  crawled_not_indexed: "Crawled but not indexed",
  discovered_not_indexed: "Discovered but not indexed",
  canonical_mismatch: "Canonical mismatch",
  blocked: "Blocked",
  never_inspected: "Never inspected",
};

const BUCKET_TONE: Record<IndexingSummaryBucket, string> = {
  indexed: "text-success",
  not_indexed: "text-critical",
  crawled_not_indexed: "text-warning",
  discovered_not_indexed: "text-warning",
  canonical_mismatch: "text-warning",
  blocked: "text-critical",
  never_inspected: "text-muted-foreground",
};

const PRIORITY_TONE: Record<string, string> = {
  critical: "border-critical/30 bg-critical/10 text-critical",
  high: "border-warning/30 bg-warning/10 text-warning",
  medium: "border-border text-muted-foreground",
  low: "border-border text-muted-foreground",
};

type SortKey = "priority" | "position" | "impressions";
const SORTERS: Record<SortKey, (c: IndexingCandidate) => number> = {
  priority: (c) => c.priorityScore,
  position: (c) => -(c.currentPosition ?? 9999),
  impressions: (c) => c.impressions,
};

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

function inspectionResultLink(insp: UrlInspection | null): string | null {
  const raw = insp?.raw_response;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const inspectionResult = (raw as Record<string, unknown>).inspectionResult;
  if (
    !inspectionResult ||
    typeof inspectionResult !== "object" ||
    Array.isArray(inspectionResult)
  ) {
    return null;
  }
  const link = (inspectionResult as Record<string, unknown>)
    .inspectionResultLink;
  return typeof link === "string" &&
    link.startsWith("https://search.google.com/")
    ? link
    : null;
}

function RequestIndexingPanel({
  url,
  inspectionLink,
}: {
  url: string;
  inspectionLink: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs font-medium text-primary">
        Request indexing manually
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
        <p className="text-muted-foreground">
          Google has no general-purpose API for requesting indexing of an
          ordinary page. Paste this URL into Google Search Console -&gt; URL
          Inspection -&gt; Request indexing.
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy URL"}
          </Button>
          <a
            href={
              inspectionLink ??
              "https://search.google.com/search-console/welcome?action=inspect"
            }
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-muted-foreground hover:border-primary hover:text-primary"
          >
            <ExternalLink className="h-3 w-3" />
            {inspectionLink
              ? "Open this inspection in Search Console"
              : "Open URL Inspection"}
          </a>
        </div>
      </div>
    </details>
  );
}

function HistoryPanel({ siteId, url }: { siteId: string; url: string }) {
  const [open, setOpen] = useState(false);
  const historyQuery = useUrlInspectionHistory(siteId, url, open);
  const history = historyQuery.data ?? [];

  function describeChange(
    curr: UrlInspectionHistory,
    prev: UrlInspectionHistory | undefined,
  ): string[] {
    if (!prev) return ["First recorded inspection."];
    const changes: string[] = [];
    if (curr.ninja_status !== prev.ninja_status) {
      changes.push(
        `${BUCKET_LABELS[prev.ninja_status as IndexingSummaryBucket] ?? prev.ninja_status} -> ${BUCKET_LABELS[curr.ninja_status as IndexingSummaryBucket] ?? curr.ninja_status}`,
      );
    }
    if (curr.google_canonical !== prev.google_canonical) {
      changes.push("Google canonical changed");
    }
    if (curr.last_crawl_time !== prev.last_crawl_time) {
      changes.push("Last crawl updated");
    }
    if (curr.robots_txt_state !== prev.robots_txt_state) {
      changes.push(
        `Robots ${prev.robots_txt_state ?? "unknown"} -> ${curr.robots_txt_state ?? "unknown"}`,
      );
    }
    return changes.length > 0
      ? changes
      : ["No change from the previous inspection."];
  }

  return (
    <details
      className="mt-1"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
        History
      </summary>
      <div className="mt-1 space-y-1 text-xs">
        {historyQuery.isLoading ? (
          <Skeleton className="h-10" />
        ) : history.length === 0 ? (
          <p className="text-muted-foreground">No history yet.</p>
        ) : (
          history.map((h, i) => (
            <div key={h.id} className="border-l-2 border-border pl-2">
              <p className="text-muted-foreground">
                {relativeTime(h.inspected_at)}
              </p>
              <ul className="list-disc pl-4">
                {describeChange(h, history[i + 1]).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </details>
  );
}

/**
 * Indexing (Ranking Growth Roadmap Phase 4) - a priority-driven Google URL
 * Inspection tracker. The candidate set is built entirely from data this app
 * already has (GSC opportunities, the site's own sitemap lastmod, prior
 * inspection state, Site Audit flags - see indexing-priority.ts), never a
 * blind crawl of every URL. Inspecting a URL calls the real Search Console
 * URL Inspection API via supabase/functions/inspect-urls; there is no
 * general-purpose "submit for indexing" API for ordinary pages, so
 * high-priority URLs get a manual Request Indexing panel instead.
 */
export function IndexingPage() {
  const privacy = usePrivacyMode();
  const sitesQuery = useSites();
  const [params, setParams] = useSearchParams();
  const [bucketFilter, setBucketFilter] =
    useState<IndexingSummaryBucket | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sites = (sitesQuery.data ?? []).filter((s) => s.is_active);
  const siteId =
    params.get("site") && sites.some((s) => s.id === params.get("site"))
      ? (params.get("site") as string)
      : (sites[0]?.id ?? "");
  const site = sites.find((s) => s.id === siteId) ?? null;

  function setSite(id: string) {
    const next = new URLSearchParams(params);
    next.set("site", id);
    setParams(next, { replace: true });
    setSelected(new Set());
  }

  const opportunitiesQuery = useKeywordOpportunities(siteId, DAYS);
  const inspectionsQuery = useUrlInspections(siteId);
  const lastmodsQuery = useSiteLastmods(site?.domain ?? "");
  const auditQuery = useLatestSiteAuditPages(siteId);
  const inspectMutation = useTriggerUrlInspection(siteId);

  const inspectionsByUrl = useMemo(() => {
    const map = new Map<string, UrlInspection>();
    for (const row of inspectionsQuery.data ?? []) map.set(row.url, row);
    return map;
  }, [inspectionsQuery.data]);

  const technicalFlagsByUrl = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of auditQuery.pages ?? []) {
      const flags: string[] = [];
      if (p.meta_robots_noindex) flags.push("noindex");
      if (p.canonical_url && p.is_self_canonical === false) {
        flags.push("non-self canonical");
      }
      if (!p.canonical_url) flags.push("missing canonical");
      if (flags.length > 0) map.set(p.url, flags);
    }
    return map;
  }, [auditQuery.pages]);

  const candidates = useMemo(
    () =>
      buildIndexingCandidates({
        opportunityRows: opportunitiesQuery.data ?? [],
        siteLastmods: lastmodsQuery.data ?? new Map(),
        inspections: inspectionsByUrl,
        technicalFlagsByUrl,
      }),
    [
      opportunitiesQuery.data,
      lastmodsQuery.data,
      inspectionsByUrl,
      technicalFlagsByUrl,
    ],
  );

  const summary = useMemo(
    () => summarizeIndexingCandidates(candidates),
    [candidates],
  );

  const filtered = useMemo(
    () =>
      bucketFilter
        ? candidates.filter((c) => summaryBucketFor(c) === bucketFilter)
        : candidates,
    [candidates, bucketFilter],
  );

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => SORTERS[sortKey](b) - SORTERS[sortKey](a)),
    [filtered, sortKey],
  );

  const actionQueue = useMemo(
    () =>
      candidates
        .filter(
          (c) => c.priorityLevel === "critical" || c.priorityLevel === "high",
        )
        .slice(0, ACTION_QUEUE_SIZE),
    [candidates],
  );

  const siteLastmods = lastmodsQuery.data ?? new Map<string, string>();

  function inspectOne(url: string) {
    inspectMutation.mutate({
      urls: [url],
      force: true,
      siteLastmodByUrl: { [url]: siteLastmods.get(url) ?? null },
    });
  }

  function inspectSelected() {
    const urls = [...selected].slice(0, MAX_BATCH);
    const siteLastmodByUrl: Record<string, string | null> = {};
    for (const u of urls) siteLastmodByUrl[u] = siteLastmods.get(u) ?? null;
    inspectMutation.mutate({ urls, force: true, siteLastmodByUrl });
    setSelected(new Set());
  }

  function toggleSelected(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else if (next.size < MAX_BATCH) next.add(url);
      return next;
    });
  }

  if (sitesQuery.isLoading) return <Skeleton className="h-64" />;
  if (sites.length === 0) {
    return (
      <EmptyState
        title="No sites yet"
        description="Add a website in Sites before there is anything to inspect."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Indexing</h1>
          <p className="text-sm text-muted-foreground">
            Google URL Inspection, prioritised - which important URLs are
            indexed, why the rest matter, and what to do about them.
            {!site?.gsc_property && (
              <> No GSC property configured for this site yet.</>
            )}
          </p>
        </div>
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
      </div>

      {opportunitiesQuery.isLoading || inspectionsQuery.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {(Object.keys(BUCKET_LABELS) as IndexingSummaryBucket[]).map(
              (b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBucketFilter(bucketFilter === b ? null : b)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    bucketFilter === b
                      ? "border-primary bg-primary/10"
                      : "border-border bg-card hover:bg-muted/50",
                  )}
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {BUCKET_LABELS[b]}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-xl font-bold tabular-nums",
                      BUCKET_TONE[b],
                    )}
                  >
                    {summary[b]}
                  </p>
                </button>
              ),
            )}
          </div>

          {inspectMutation.error && (
            <p className="text-xs text-critical">
              {inspectMutation.error instanceof Error
                ? inspectMutation.error.message
                : "Could not inspect these URLs."}
            </p>
          )}

          {actionQueue.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Indexing Action Queue</h2>
              <p className="text-xs text-muted-foreground">
                The highest-priority URLs to work through manually - Critical
                and High only, ranked by priority score.
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                {actionQueue.map((c) => (
                  <Card key={c.url}>
                    <div className="space-y-1.5 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="max-w-[16rem] truncate text-sm font-medium">
                          {privacy.enabled
                            ? privacy.maskText(c.url, `queue:${c.url}`)
                            : shortPath(c.url)}
                        </p>
                        <span
                          className={cn(
                            "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                            PRIORITY_TONE[c.priorityLevel],
                          )}
                        >
                          {c.priorityLevel}
                        </span>
                      </div>
                      <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                        {c.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          loading={inspectMutation.isPending}
                          onClick={() => inspectOne(c.url)}
                        >
                          <SearchCheck className="h-3.5 w-3.5" /> Inspect
                        </Button>
                      </div>
                      <RequestIndexingPanel
                        url={c.url}
                        inspectionLink={inspectionResultLink(c.inspection)}
                      />
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

          <p className="text-xs text-muted-foreground">
            Sitemap submission is already automated; manual indexing requests
            should only be used for high-priority URLs.
          </p>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                Tracked URLs ({sorted.length})
              </h2>
              <div className="flex items-center gap-2">
                {selected.size > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    loading={inspectMutation.isPending}
                    onClick={inspectSelected}
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Inspect selected (
                    {selected.size})
                  </Button>
                )}
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="h-9 rounded-md border border-border bg-card px-2 text-sm"
                >
                  <option value="priority">Sort: Inspection priority</option>
                  <option value="position">Sort: Best ranking position</option>
                  <option value="impressions">Sort: Highest impressions</option>
                </select>
              </div>
            </div>

            {sorted.length === 0 ? (
              <EmptyState
                icon={SearchCheck}
                title="No candidate URLs yet"
                description="Candidates appear once this site has Search Console query data, a recently changed sitemap entry, or a prior inspection."
              />
            ) : (
              <Card>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="px-2 py-2"></th>
                        <th className="px-2 py-2 font-medium">URL</th>
                        <th className="px-2 py-2 font-medium">Type</th>
                        <th className="px-2 py-2 font-medium">Index status</th>
                        <th className="px-2 py-2 font-medium">Last crawl</th>
                        <th className="px-2 py-2 font-medium">
                          Canonical (Google / declared)
                        </th>
                        <th className="px-2 py-2 font-medium">Robots</th>
                        <th className="px-2 py-2 font-medium">Sitemap</th>
                        <th className="px-2 py-2 text-right font-medium">
                          Impr.
                        </th>
                        <th className="px-2 py-2 text-right font-medium">
                          Clicks
                        </th>
                        <th className="px-2 py-2 text-right font-medium">
                          Pos.
                        </th>
                        <th className="px-2 py-2 text-right font-medium">
                          Opp. score
                        </th>
                        <th className="px-2 py-2 font-medium">Priority</th>
                        <th className="px-2 py-2 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.slice(0, 300).map((c) => {
                        const insp = c.inspection;
                        return (
                          <tr
                            key={c.url}
                            className="border-b border-border align-top last:border-0"
                          >
                            <td className="px-2 py-2">
                              <input
                                type="checkbox"
                                checked={selected.has(c.url)}
                                onChange={() => toggleSelected(c.url)}
                                aria-label={`Select ${c.url}`}
                              />
                            </td>
                            <td className="max-w-[14rem] px-2 py-2">
                              <p className="truncate">
                                {privacy.enabled
                                  ? privacy.maskText(c.url, `idx:${c.url}`)
                                  : shortPath(c.url)}
                              </p>
                              <details className="mt-1 text-xs text-muted-foreground">
                                <summary className="flex cursor-pointer items-center gap-0.5">
                                  Why <ChevronDown className="h-3 w-3" />
                                </summary>
                                <ul className="list-disc space-y-0.5 pl-4">
                                  {c.reasons.map((r) => (
                                    <li key={r}>{r}</li>
                                  ))}
                                </ul>
                              </details>
                              <HistoryPanel siteId={siteId} url={c.url} />
                            </td>
                            <td className="px-2 py-2 text-xs text-muted-foreground">
                              {c.pageType}
                            </td>
                            <td className="px-2 py-2">
                              <span
                                className={cn(
                                  "text-xs font-medium",
                                  BUCKET_TONE[summaryBucketFor(c)],
                                )}
                              >
                                {BUCKET_LABELS[summaryBucketFor(c)]}
                              </span>
                              {insp?.coverage_state && (
                                <p className="text-[10px] text-muted-foreground">
                                  {insp.coverage_state}
                                </p>
                              )}
                            </td>
                            <td className="px-2 py-2 text-xs text-muted-foreground">
                              {insp?.last_crawl_time
                                ? relativeTime(insp.last_crawl_time)
                                : "-"}
                            </td>
                            <td className="max-w-[12rem] px-2 py-2 text-xs text-muted-foreground">
                              <p className="truncate">
                                G: {insp?.google_canonical ?? "-"}
                              </p>
                              <p className="truncate">
                                Declared: {insp?.user_canonical ?? "-"}
                              </p>
                            </td>
                            <td className="px-2 py-2 text-xs text-muted-foreground">
                              {insp?.robots_txt_state ?? "-"}
                            </td>
                            <td className="px-2 py-2 text-xs text-muted-foreground">
                              {insp
                                ? insp.sitemaps.length > 0
                                  ? "Yes"
                                  : "No"
                                : "-"}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {formatNumber(c.impressions)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {formatNumber(c.clicks)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {formatPosition(c.currentPosition)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                              {c.opportunityScore ?? "-"}
                            </td>
                            <td className="px-2 py-2">
                              <span
                                className={cn(
                                  "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                                  PRIORITY_TONE[c.priorityLevel],
                                )}
                              >
                                {c.priorityLevel}
                              </span>
                            </td>
                            <td className="px-2 py-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                loading={inspectMutation.isPending}
                                onClick={() => inspectOne(c.url)}
                              >
                                <SearchCheck className="h-3.5 w-3.5" /> Inspect
                              </Button>
                              <RequestIndexingPanel
                                url={c.url}
                                inspectionLink={inspectionResultLink(insp)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}
