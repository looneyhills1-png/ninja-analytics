import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { format } from "date-fns";
import { useKeywordOpportunities, useSitePageDaily } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import { computeDecayingPages } from "@/lib/decay";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { formatCtr, formatNumber, formatPosition } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  queryCount: number;
  decaying: boolean;
  decayChangePct: number | null;
}

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/** Per-page browser: every ranking URL seen for this site, with aggregate
 * clicks/impressions/CTR/position, how many distinct queries rank to it
 * (cannibalisation shows up here as "many queries, weak position"), and a
 * content-decay flag reusing the existing lib/decay.ts logic. */
export function KeywordsPagesPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);
  const pageDailyQuery = useSitePageDaily(siteId, days);
  const [sortKey, setSortKey] = useState<"clicks" | "queries" | "position">(
    "clicks",
  );

  const decays = useMemo(
    () =>
      computeDecayingPages(
        pageDailyQuery.data ?? [],
        days,
        format(new Date(), "yyyy-MM-dd"),
        1000,
      ),
    [pageDailyQuery.data, days],
  );
  const decayByPage = useMemo(
    () => new Map(decays.map((d) => [d.page, d.changePct])),
    [decays],
  );

  const pages = useMemo(() => {
    const opps = opportunitiesQuery.data ?? [];
    const byPage = new Map<
      string,
      {
        clicks: number;
        impressions: number;
        queries: Set<string>;
        positions: number[];
      }
    >();
    for (const row of opps) {
      if (!row.rankingUrl) continue;
      let agg = byPage.get(row.rankingUrl);
      if (!agg) {
        agg = { clicks: 0, impressions: 0, queries: new Set(), positions: [] };
        byPage.set(row.rankingUrl, agg);
      }
      agg.clicks += row.clicks;
      agg.impressions += row.impressions;
      agg.queries.add(row.query);
      if (row.currentPosition != null) agg.positions.push(row.currentPosition);
    }
    const out: PageRow[] = [];
    for (const [page, agg] of byPage) {
      const position = agg.positions.length
        ? agg.positions.reduce((a, b) => a + b, 0) / agg.positions.length
        : null;
      const decayChangePct = decayByPage.get(page) ?? null;
      out.push({
        page,
        clicks: agg.clicks,
        impressions: agg.impressions,
        ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : null,
        position,
        queryCount: agg.queries.size,
        decaying: decayChangePct != null,
        decayChangePct,
      });
    }
    return out;
  }, [opportunitiesQuery.data, decayByPage]);

  const sorted = useMemo(() => {
    const copy = [...pages];
    if (sortKey === "clicks") copy.sort((a, b) => b.clicks - a.clicks);
    else if (sortKey === "queries")
      copy.sort((a, b) => b.queryCount - a.queryCount);
    else copy.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    return copy;
  }, [pages, sortKey]);

  if (opportunitiesQuery.isLoading || pageDailyQuery.isLoading)
    return <Skeleton className="h-96" />;
  if (opportunitiesQuery.isError)
    return <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />;
  if (pages.length === 0) {
    return (
      <EmptyState
        title="No ranking pages yet"
        description="Pages appear here once the query+page breakdown has synced for this site."
      />
    );
  }

  const decayingCount = pages.filter((p) => p.decaying).length;
  const multiQueryPages = pages.filter((p) => p.queryCount >= 2).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Ranking pages" value={formatNumber(pages.length)} />
        <StatCard
          label="Multi-query pages"
          value={formatNumber(multiQueryPages)}
          hint="Two or more queries ranking to the same URL."
        />
        <StatCard
          label="Decaying pages"
          value={formatNumber(decayingCount)}
          hint="Clicks down 25%+ vs the prior period."
        />
        <StatCard
          label="Total clicks"
          value={formatNumber(pages.reduce((s, p) => s + p.clicks, 0))}
        />
      </div>

      <div className="flex items-center gap-2">
        <select
          value={sortKey}
          onChange={(e) =>
            setSortKey(e.target.value as "clicks" | "queries" | "position")
          }
          className="h-9 rounded-md border border-border bg-card px-2 text-sm"
        >
          <option value="clicks">Sort: Clicks</option>
          <option value="queries">Sort: Query count</option>
          <option value="position">Sort: Best position</option>
        </select>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Page</th>
                <th className="px-2 py-2 text-right font-medium">Queries</th>
                <th className="px-2 py-2 text-right font-medium">Clicks</th>
                <th className="px-2 py-2 text-right font-medium">Impr.</th>
                <th className="px-2 py-2 text-right font-medium">CTR</th>
                <th className="px-2 py-2 text-right font-medium">Pos.</th>
                <th className="px-2 py-2 font-medium">Signal</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.page}
                  className="border-b border-border last:border-0"
                >
                  <td className="max-w-[16rem] px-3 py-2">
                    <span
                      className="block truncate"
                      title={privacy.enabled ? undefined : row.page}
                    >
                      {privacy.enabled
                        ? privacy.maskText(row.page, `kw-page:${row.page}`)
                        : shortPath(row.page)}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {row.queryCount}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatNumber(row.clicks)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                    {formatNumber(row.impressions)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatCtr(row.ctr)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatPosition(row.position)}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-1">
                      {row.queryCount >= 2 && (
                        <span className="rounded border border-critical/30 bg-critical/10 px-1.5 py-0.5 text-[10px] font-medium text-critical">
                          {row.queryCount} queries
                        </span>
                      )}
                      {row.decaying && (
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                            "border-critical/30 bg-critical/10 text-critical",
                          )}
                        >
                          Decaying{" "}
                          {row.decayChangePct != null
                            ? `${row.decayChangePct.toFixed(0)}%`
                            : ""}
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
    </div>
  );
}
