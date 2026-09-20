import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useKeywordOpportunities } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { MetricDelta } from "@/components/ui/stat-card";
import { formatCtr, formatNumber, formatPosition } from "@/lib/format";
import { cn } from "@/lib/utils";

type BrandFilter = "all" | "branded" | "non-branded";
type TrendFilter = "all" | "rising" | "falling" | "stable" | "new" | "lost";

/** Full query browser - every query the site has data for (not just the ones
 * that crossed an opportunity threshold), with branded/non-branded and trend
 * filters, since the brief calls this out as its own screen distinct from
 * Opportunities. */
export function KeywordsQueriesPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState<BrandFilter>("all");
  const [trend, setTrend] = useState<TrendFilter>("all");

  const rows = useMemo(
    () => opportunitiesQuery.data ?? [],
    [opportunitiesQuery.data],
  );

  const filtered = useMemo(() => {
    let out = rows;
    if (brand === "branded") out = out.filter((r) => r.branded);
    if (brand === "non-branded") out = out.filter((r) => !r.branded);
    if (trend !== "all") out = out.filter((r) => r.trend === trend);
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      out = out.filter((r) => r.query.toLowerCase().includes(needle));
    }
    return [...out].sort((a, b) => b.impressions - a.impressions);
  }, [rows, brand, trend, search]);

  if (opportunitiesQuery.isLoading) return <Skeleton className="h-96" />;
  if (opportunitiesQuery.isError)
    return <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No query data yet"
        description="Queries appear here once Search Console data has synced for this site."
      />
    );
  }

  const brandedCount = rows.filter((r) => r.branded).length;
  const withBingCorroboration = rows.filter(
    (r) => r.bingImpressions > 0,
  ).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total queries" value={formatNumber(rows.length)} />
        <StatCard
          label="Branded / Non-branded"
          value={`${formatNumber(brandedCount)} / ${formatNumber(rows.length - brandedCount)}`}
        />
        <StatCard
          label="Rising"
          value={formatNumber(rows.filter((r) => r.trend === "rising").length)}
        />
        <StatCard
          label="Also seen in Bing"
          value={formatNumber(withBingCorroboration)}
          hint="Queries with Bing impressions too - corroborates the Google signal."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search queries..."
          className="h-9 w-56 rounded-md border border-border bg-card px-3 text-sm"
        />
        <select
          value={brand}
          onChange={(e) => setBrand(e.target.value as BrandFilter)}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm"
        >
          <option value="all">All queries</option>
          <option value="branded">Branded only</option>
          <option value="non-branded">Non-branded only</option>
        </select>
        <select
          value={trend}
          onChange={(e) => setTrend(e.target.value as TrendFilter)}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm"
        >
          <option value="all">Any trend</option>
          <option value="rising">Rising</option>
          <option value="falling">Falling</option>
          <option value="stable">Stable</option>
          <option value="new">New</option>
          <option value="lost">Lost</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No queries match"
          description="Try clearing a filter."
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Query</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 font-medium">Trend</th>
                  <th className="px-2 py-2 text-right font-medium">Clicks</th>
                  <th className="px-2 py-2 text-right font-medium">Impr.</th>
                  <th className="px-2 py-2 text-right font-medium">CTR</th>
                  <th className="px-2 py-2 text-right font-medium">Pos.</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.query}
                    className="border-b border-border last:border-0"
                  >
                    <td className="max-w-[16rem] truncate px-3 py-2">
                      {privacy.maskText(row.query, `kw-q:${row.query}`)}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {row.branded ? "Branded" : "Non-branded"}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                          row.trend === "rising" &&
                            "border-success/30 bg-success/10 text-success",
                          row.trend === "falling" &&
                            "border-critical/30 bg-critical/10 text-critical",
                          row.trend === "stable" &&
                            "border-border text-muted-foreground",
                          row.trend === "new" &&
                            "border-violet-500/30 bg-violet-500/10 text-violet-500",
                          row.trend === "lost" &&
                            "border-border bg-muted text-muted-foreground",
                        )}
                      >
                        {row.trend}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      <div>{formatNumber(row.clicks)}</div>
                      <div className="text-[10px]">
                        <MetricDelta change={row.clicksChangePct} compact />
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                      {formatNumber(row.impressions)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatCtr(row.ctr)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatPosition(row.currentPosition)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
