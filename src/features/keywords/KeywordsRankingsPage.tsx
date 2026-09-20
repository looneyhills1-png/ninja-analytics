import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { ChevronDown, ChevronRight, Info, Plus, Trash2 } from "lucide-react";
import {
  useAddTrackedRankKeyword,
  useEngineQueryPositions,
  useKeywordOpportunities,
  useRankSnapshots,
  useRemoveTrackedRankKeyword,
  useTrackedRankKeywords,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import {
  computeEngineAveragePositions,
  computeTrackedKeywordInsights,
  type RankDevice,
  type RankEngine,
} from "@/lib/rank-tracking";
import { RankHistoryChart } from "@/features/keywords/RankHistoryChart";
import { RecordObservationForm } from "@/features/keywords/RecordObservationForm";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber, formatPosition } from "@/lib/format";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

function movementBadge(change: number | null) {
  if (change == null) return <span className="text-muted-foreground">-</span>;
  if (change === 0) return <span className="text-muted-foreground">0</span>;
  const improved = change > 0;
  return (
    <span className={improved ? "text-success" : "text-critical"}>
      {improved ? "+" : ""}
      {change}
    </span>
  );
}

/**
 * GSC average position (below, unchanged from Phase 1) vs real observed
 * rank - two distinct sections, never merged into one number. Tracked
 * keywords are configured here (site/engine/device/country) and their
 * observations are recorded here (manual check or a full SERP entry, which
 * also feeds the Competitors / Observed Keyword Gap data) and stored,
 * append-only, in rank_snapshots.
 */
export function KeywordsRankingsPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);
  const trackedQuery = useTrackedRankKeywords(siteId);
  const snapshotsQuery = useRankSnapshots(siteId);
  const positionsQuery = useEngineQueryPositions(siteId, days);
  const addMutation = useAddTrackedRankKeyword(siteId);
  const removeMutation = useRemoveTrackedRankKeyword(siteId);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState({
    query: "",
    engine: "google" as RankEngine,
    device: "desktop" as RankDevice,
    country: "",
    location: "",
  });

  const gscPositions = useMemo(
    () =>
      computeEngineAveragePositions(
        (positionsQuery.data ?? []).map((r) => ({
          engine: r.engine,
          query: r.query,
          impressions: r.impressions,
          averagePosition: r.average_position,
        })),
      ),
    [positionsQuery.data],
  );

  const insights = useMemo(() => {
    if (!trackedQuery.data) return [];
    const snapshots = (snapshotsQuery.data ?? []).map((s) => ({
      id: s.id,
      siteId: s.site_id,
      query: s.query,
      engine: s.engine,
      device: s.device,
      country: s.country,
      location: s.location,
      rankingUrl: s.ranking_url,
      observedRank: s.observed_rank,
      source: s.source,
      checkedAt: s.checked_at,
    }));
    const keywords = trackedQuery.data.map((k) => ({
      id: k.id,
      siteId: k.site_id,
      query: k.query,
      engine: k.engine,
      device: k.device,
      country: k.country,
      location: k.location,
      createdAt: k.created_at,
    }));
    return computeTrackedKeywordInsights(keywords, snapshots, gscPositions);
  }, [trackedQuery.data, snapshotsQuery.data, gscPositions]);

  const rows = opportunitiesQuery.data ?? [];
  const tracked = rows.filter((r) => r.currentPosition != null);

  async function handleAdd() {
    if (!form.query.trim()) return;
    await addMutation.mutateAsync({
      siteId,
      query: form.query.trim(),
      engine: form.engine,
      device: form.device,
      country: form.country.trim() || null,
      location: form.location.trim() || null,
    });
    setForm({
      query: "",
      engine: "google",
      device: "desktop",
      country: "",
      location: "",
    });
  }

  return (
    <div className="space-y-6">
      <Card className="border-primary/30 bg-primary/5">
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Observed rank</span>{" "}
            below comes from an actual check (manual, or a recorded SERP
            observation) - it is never a paid rank-tracking API.{" "}
            <span className="font-medium text-foreground">
              GSC average position
            </span>{" "}
            is Google's own reported average across all impressions in the
            window. The two are kept in separate columns deliberately.
          </p>
        </div>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Tracked keywords</h2>
        <Card>
          <div className="flex flex-wrap items-end gap-2 border-b border-border p-3">
            <input
              value={form.query}
              onChange={(e) =>
                setForm((f) => ({ ...f, query: e.target.value }))
              }
              placeholder="Keyword to track..."
              className="h-9 w-56 rounded-md border border-border bg-card px-3 text-sm"
            />
            <select
              value={form.engine}
              onChange={(e) =>
                setForm((f) => ({ ...f, engine: e.target.value as RankEngine }))
              }
              className="h-9 rounded-md border border-border bg-card px-2 text-sm"
            >
              <option value="google">Google</option>
              <option value="bing">Bing</option>
            </select>
            <select
              value={form.device}
              onChange={(e) =>
                setForm((f) => ({ ...f, device: e.target.value as RankDevice }))
              }
              className="h-9 rounded-md border border-border bg-card px-2 text-sm"
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
            </select>
            <input
              value={form.country}
              onChange={(e) =>
                setForm((f) => ({ ...f, country: e.target.value }))
              }
              placeholder="Country (optional)"
              className="h-9 w-32 rounded-md border border-border bg-card px-2 text-sm"
            />
            <input
              value={form.location}
              onChange={(e) =>
                setForm((f) => ({ ...f, location: e.target.value }))
              }
              placeholder="Location (optional)"
              className="h-9 w-40 rounded-md border border-border bg-card px-2 text-sm"
            />
            <Button
              size="sm"
              loading={addMutation.isPending}
              onClick={() => void handleAdd()}
            >
              <Plus className="h-3.5 w-3.5" /> Track
            </Button>
          </div>
          {addMutation.error && (
            <p className="px-3 pt-2 text-xs text-critical">
              {addMutation.error instanceof Error
                ? addMutation.error.message
                : "Could not save."}
            </p>
          )}

          {trackedQuery.isLoading || snapshotsQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-24" />
            </div>
          ) : insights.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No tracked keywords yet"
                description="Add a keyword above to start recording its observed rank."
              />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {insights.map((insight) => {
                const isOpen = expanded === insight.keyword.id;
                return (
                  <div key={insight.keyword.id}>
                    <div className="flex flex-wrap items-center gap-3 p-3">
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded(isOpen ? null : insight.keyword.id)
                        }
                        className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
                        aria-label={isOpen ? "Collapse" : "Expand"}
                      >
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                      <div className="min-w-[10rem] flex-1">
                        <p className="truncate text-sm font-medium">
                          {privacy.maskText(
                            insight.keyword.query,
                            `rank-kw:${insight.keyword.id}`,
                          )}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {insight.keyword.engine} &middot;{" "}
                          {insight.keyword.device}
                          {insight.keyword.country &&
                            ` · ${insight.keyword.country}`}
                          {insight.keyword.location &&
                            ` · ${insight.keyword.location}`}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-muted-foreground">
                          Observed
                        </p>
                        <p className="text-lg font-semibold tabular-nums">
                          {insight.currentRank != null
                            ? `#${insight.currentRank}`
                            : "-"}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-muted-foreground">
                          GSC avg.
                        </p>
                        <p className="text-sm tabular-nums text-muted-foreground">
                          {formatPosition(insight.gscAveragePosition)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-muted-foreground">
                          1d
                        </p>
                        <p className="text-sm tabular-nums">
                          {movementBadge(insight.movement.d1)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-muted-foreground">
                          7d
                        </p>
                        <p className="text-sm tabular-nums">
                          {movementBadge(insight.movement.d7)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-muted-foreground">
                          28d
                        </p>
                        <p className="text-sm tabular-nums">
                          {movementBadge(insight.movement.d28)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-muted-foreground">
                          Best / Worst
                        </p>
                        <p className="text-sm tabular-nums">
                          {insight.bestRank ?? "-"} / {insight.worstRank ?? "-"}
                        </p>
                      </div>
                      <div className="min-w-[8rem] text-right text-xs text-muted-foreground">
                        {insight.currentCheckedAt ? (
                          <>
                            {relativeTime(insight.currentCheckedAt)}
                            <br />
                            <span
                              className={cn(
                                "rounded border px-1 text-[10px]",
                                insight.currentSource === "manual"
                                  ? "border-border"
                                  : "border-primary/30 text-primary",
                              )}
                            >
                              {insight.currentSource === "manual"
                                ? "manual"
                                : "observed SERP"}
                            </span>
                          </>
                        ) : (
                          "Never checked"
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label="Stop tracking"
                        onClick={() =>
                          void removeMutation.mutateAsync(insight.keyword.id)
                        }
                        className="shrink-0 text-muted-foreground hover:text-critical"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {isOpen && (
                      <div className="space-y-3 border-t border-border bg-muted/10 p-3">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div>
                            <p className="mb-1 text-xs font-semibold">
                              Observed-rank history
                            </p>
                            <RankHistoryChart history={insight.history} />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            <p>
                              <span className="font-medium text-foreground">
                                Ranking URL:
                              </span>{" "}
                              {insight.currentRankingUrl
                                ? privacy.maskText(
                                    insight.currentRankingUrl,
                                    `rank-kw-url:${insight.keyword.id}`,
                                  )
                                : "-"}
                            </p>
                            <p className="mt-1">
                              <span className="font-medium text-foreground">
                                First seen:
                              </span>{" "}
                              {insight.firstSeen
                                ? relativeTime(insight.firstSeen)
                                : "-"}
                            </p>
                            <p className="mt-1">
                              <span className="font-medium text-foreground">
                                Last seen:
                              </span>{" "}
                              {insight.lastSeen
                                ? relativeTime(insight.lastSeen)
                                : "-"}
                            </p>
                            <p className="mt-1">
                              <span className="font-medium text-foreground">
                                Observations recorded:
                              </span>{" "}
                              {formatNumber(insight.history.length)}
                            </p>
                          </div>
                        </div>
                        <RecordObservationForm
                          siteId={siteId}
                          trackedRankKeywordId={insight.keyword.id}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          GSC average position (all queries)
        </h2>
        {opportunitiesQuery.isLoading ? (
          <Skeleton className="h-64" />
        ) : opportunitiesQuery.isError ? (
          <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />
        ) : tracked.length === 0 ? (
          <EmptyState
            title="No positioned queries yet"
            description="Queries with a GSC average position appear here once Search Console data has synced."
          />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Query</th>
                    <th className="px-2 py-2 font-medium">Ranking URL</th>
                    <th className="px-2 py-2 text-right font-medium">
                      Avg. position
                    </th>
                    <th className="px-2 py-2 text-right font-medium">
                      Previous
                    </th>
                    <th className="px-2 py-2 text-right font-medium">Impr.</th>
                  </tr>
                </thead>
                <tbody>
                  {[...tracked]
                    .sort(
                      (a, b) =>
                        (a.currentPosition ?? 999) - (b.currentPosition ?? 999),
                    )
                    .slice(0, 50)
                    .map((row) => (
                      <tr
                        key={row.query}
                        className="border-b border-border last:border-0"
                      >
                        <td className="max-w-[14rem] truncate px-3 py-2">
                          {privacy.maskText(row.query, `kw-rank:${row.query}`)}
                        </td>
                        <td className="max-w-[12rem] truncate px-2 py-2 text-xs text-muted-foreground">
                          {row.rankingUrl
                            ? privacy.maskText(
                                row.rankingUrl,
                                `kw-rank-url:${row.query}`,
                              )
                            : "-"}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold tabular-nums">
                          {formatPosition(row.currentPosition)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {formatPosition(row.previousPosition)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {formatNumber(row.impressions)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
