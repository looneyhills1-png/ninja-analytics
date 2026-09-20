import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useKeywordOpportunities } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber, formatPosition } from "@/lib/format";
import { Info, Radar } from "lucide-react";

type SortKey = "position" | "impressions" | "stability";

/**
 * GSC average position per query. This is deliberately NOT a live SERP rank -
 * GSC's "average position" is Google's own reported average across every
 * impression, device and location for the date range, not a single observed
 * rank. A future Phase 2 (rank_snapshots table, already in the schema) will
 * add real point-in-time observed-rank tracking; until that exists this page
 * says so plainly rather than implying it's already live.
 */
export function KeywordsRankingsPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);
  const [sortKey, setSortKey] = useState<SortKey>("position");

  const tracked = useMemo(
    () =>
      (opportunitiesQuery.data ?? []).filter((r) => r.currentPosition != null),
    [opportunitiesQuery.data],
  );

  const sorted = useMemo(() => {
    const copy = [...tracked];
    if (sortKey === "position") {
      copy.sort(
        (a, b) => (a.currentPosition ?? 999) - (b.currentPosition ?? 999),
      );
    } else if (sortKey === "impressions") {
      copy.sort((a, b) => b.impressions - a.impressions);
    } else {
      copy.sort(
        (a, b) => (a.positionStability ?? 999) - (b.positionStability ?? 999),
      );
    }
    return copy;
  }, [tracked, sortKey]);

  if (opportunitiesQuery.isLoading) return <Skeleton className="h-96" />;
  if (opportunitiesQuery.isError)
    return <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />;

  return (
    <div className="space-y-4">
      <Card className="border-primary/30 bg-primary/5">
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Average position
            </span>{" "}
            below is Google Search Console's own reported average across all
            impressions in the window - it is not a single, point-in-time
            observed SERP rank. Real observed-rank tracking (device, country,
            per-check history) is planned for a later phase and will appear in
            its own column, clearly separate from this one, once it exists.
          </p>
        </div>
      </Card>

      {tracked.length === 0 ? (
        <EmptyState
          title="No positioned queries yet"
          description="Queries with a GSC average position appear here once Search Console data has synced."
        />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-9 rounded-md border border-border bg-card px-2 text-sm"
            >
              <option value="position">Sort: Best position</option>
              <option value="impressions">Sort: Impressions</option>
              <option value="stability">Sort: Most stable</option>
            </select>
          </div>
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
                    <th className="px-2 py-2 text-right font-medium">Change</th>
                    <th className="px-2 py-2 text-right font-medium">
                      Stability (σ)
                    </th>
                    <th className="px-2 py-2 text-right font-medium">Impr.</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
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
                      <td className="px-2 py-2 text-right tabular-nums">
                        {row.positionChange == null
                          ? "-"
                          : `${row.positionChange > 0 ? "+" : ""}${row.positionChange.toFixed(1)}`}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {row.positionStability == null
                          ? "-"
                          : row.positionStability.toFixed(1)}
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
        </>
      )}

      <Card>
        <div className="flex items-start gap-3 p-4">
          <Radar
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium">
              Observed live-SERP tracking - coming later
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The database already has a home for this (tracked keywords, rank
              snapshots by search engine/device/country/location, best rank,
              first/last seen, 1d/7d/28d movement) so it can be built without a
              schema change. It will use only free/permitted checking methods -
              never a paid rank-tracking API.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
