import { Fragment, useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useKeywordOpportunities } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { OpportunityBadgeList } from "@/features/keywords/OpportunityBadges";
import { ScoreBar, ScoreFactorList } from "@/features/keywords/ScoreBar";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
} from "@/features/keywords/opportunity-meta";
import {
  formatCtr,
  formatNumber,
  formatPercentChange,
  formatPosition,
} from "@/lib/format";
import type {
  KeywordOpportunityRow,
  OpportunityCategory,
} from "@/lib/keyword-opportunities";
import { cn } from "@/lib/utils";

type SortKey =
  | "score"
  | "position"
  | "impressions"
  | "clicks"
  | "positionChange"
  | "clicksChange";

const SORTERS: Record<SortKey, (row: KeywordOpportunityRow) => number> = {
  score: (r) => r.score.score,
  position: (r) => (r.currentPosition == null ? Infinity : -r.currentPosition),
  impressions: (r) => r.impressions,
  clicks: (r) => r.clicks,
  positionChange: (r) => r.positionChange ?? -Infinity,
  clicksChange: (r) => r.clicksChangePct ?? -Infinity,
};

/**
 * The full Opportunities table - every KeywordOpportunityRow field the brief
 * requires, filterable by category (honoring ?category= set by the Overview
 * page's action cards) and by a free-text query search, sortable by the
 * columns that matter most for triage.
 */
export function KeywordsOpportunitiesPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [expanded, setExpanded] = useState<string | null>(null);

  const category = params.get("category") as OpportunityCategory | null;

  function setCategory(next: OpportunityCategory | null) {
    const nextParams = new URLSearchParams(params);
    if (next) nextParams.set("category", next);
    else nextParams.delete("category");
    setParams(nextParams, { replace: true });
  }

  const rows = useMemo(
    () => opportunitiesQuery.data ?? [],
    [opportunitiesQuery.data],
  );

  const filtered = useMemo(() => {
    let out = rows;
    if (category) out = out.filter((r) => r.categories.includes(category));
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      out = out.filter((r) => r.query.toLowerCase().includes(needle));
    }
    return [...out].sort((a, b) => SORTERS[sortKey](b) - SORTERS[sortKey](a));
  }, [rows, category, search, sortKey]);

  if (opportunitiesQuery.isLoading) return <Skeleton className="h-96" />;
  if (opportunitiesQuery.isError)
    return <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No query data yet"
        description="Keyword opportunities appear here once Search Console data has synced for this site."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search queries..."
          className="h-9 w-56 rounded-md border border-border bg-card px-3 text-sm"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm"
        >
          <option value="score">Sort: Opportunity score</option>
          <option value="position">Sort: Best position</option>
          <option value="impressions">Sort: Impressions</option>
          <option value="clicks">Sort: Clicks</option>
          <option value="positionChange">Sort: Position change</option>
          <option value="clicksChange">Sort: Click change</option>
        </select>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setCategory(null)}
            className={cn(
              "rounded border px-2 py-1 text-xs font-medium",
              !category
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            All ({rows.length})
          </button>
          {CATEGORY_ORDER.map((c) => {
            const n = rows.filter((r) => r.categories.includes(c)).length;
            if (n === 0) return null;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cn(
                  "rounded border px-2 py-1 text-xs font-medium",
                  category === c
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {CATEGORY_LABEL[c]} ({n})
              </button>
            );
          })}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No queries match"
          description="Try a different category or clear the search."
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Query</th>
                  <th className="px-2 py-2 font-medium">Ranking URL</th>
                  <th className="px-2 py-2 font-medium">Category</th>
                  <th className="px-2 py-2 text-right font-medium">Pos.</th>
                  <th className="px-2 py-2 text-right font-medium">Pos. Δ</th>
                  <th className="px-2 py-2 text-right font-medium">Clicks</th>
                  <th className="px-2 py-2 text-right font-medium">Clicks Δ</th>
                  <th className="px-2 py-2 text-right font-medium">Impr.</th>
                  <th className="px-2 py-2 text-right font-medium">Impr. Δ</th>
                  <th className="px-2 py-2 text-right font-medium">CTR</th>
                  <th className="px-2 py-2 font-medium">First/Last seen</th>
                  <th className="px-2 py-2 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <Fragment key={row.query}>
                    <tr
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40"
                      onClick={() =>
                        setExpanded(expanded === row.query ? null : row.query)
                      }
                    >
                      <td className="max-w-[14rem] truncate px-3 py-2">
                        {privacy.maskText(row.query, `kw-opp:${row.query}`)}
                      </td>
                      <td className="max-w-[12rem] truncate px-2 py-2 text-xs text-muted-foreground">
                        {row.rankingUrl
                          ? privacy.maskText(
                              row.rankingUrl,
                              `kw-opp-url:${row.query}`,
                            )
                          : "-"}
                      </td>
                      <td className="px-2 py-2">
                        <OpportunityBadgeList
                          categories={row.categories}
                          max={2}
                        />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatPosition(row.currentPosition)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {row.positionChange == null
                          ? "-"
                          : `${row.positionChange > 0 ? "+" : ""}${row.positionChange.toFixed(1)}`}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatNumber(row.clicks)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {formatPercentChange(row.clicksChangePct)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {formatNumber(row.impressions)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {formatPercentChange(row.impressionsChangePct)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCtr(row.ctr)}
                      </td>
                      <td className="px-2 py-2 text-[11px] text-muted-foreground">
                        {row.firstSeen} &rarr; {row.lastSeen}
                      </td>
                      <td className="px-2 py-2">
                        <ScoreBar score={row.score} />
                      </td>
                    </tr>
                    {expanded === row.query && (
                      <tr className="border-b border-border bg-muted/20 last:border-0">
                        <td colSpan={12} className="px-4 py-3">
                          <div className="grid gap-4 md:grid-cols-2">
                            <div>
                              <p className="mb-1 text-xs font-semibold">
                                Recommended action
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {row.recommendedAction}
                              </p>
                              {row.competingUrls.length >= 2 && (
                                <div className="mt-2">
                                  <p className="text-xs font-semibold">
                                    Competing URLs
                                  </p>
                                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                                    {row.competingUrls.map((u) => (
                                      <li key={u} className="truncate">
                                        {privacy.maskText(u, `kw-opp-cu:${u}`)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                            <div>
                              <p className="mb-1 text-xs font-semibold">
                                Why this score
                              </p>
                              <ScoreFactorList score={row.score} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
