import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useKeywordOpportunities } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import {
  computeKeywordClusters,
  CLUSTER_MAX_QUERIES,
  type ClusterMapping,
} from "@/lib/keyword-clusters";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber, formatPosition } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";

const MAPPING_LABEL: Record<ClusterMapping, string> = {
  "existing-best-url": "Strengthen the ranking page",
  "improve-existing": "Improve/consolidate the existing page(s)",
  "potential-new-page": "Consider a dedicated page",
  ignore: "Low volume - monitor only",
};

const MAPPING_TONE: Record<ClusterMapping, string> = {
  "existing-best-url": "border-success/30 bg-success/10 text-success",
  "improve-existing": "border-warning/30 bg-warning/10 text-warning",
  "potential-new-page": "border-primary/30 bg-primary/10 text-primary",
  ignore: "border-border text-muted-foreground",
};

/** Lexical keyword clusters (shared significant tokens, no embeddings/API) -
 * each mapped to a next action: strengthen the existing page, consolidate a
 * cannibalised topic, or consider a new page for genuinely uncovered demand. */
export function KeywordsClustersPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);
  const [expanded, setExpanded] = useState<string | null>(null);

  const clusters = useMemo(
    () => computeKeywordClusters(opportunitiesQuery.data ?? []),
    [opportunitiesQuery.data],
  );

  if (opportunitiesQuery.isLoading) return <Skeleton className="h-96" />;
  if (opportunitiesQuery.isError)
    return <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />;
  if ((opportunitiesQuery.data ?? []).length === 0) {
    return (
      <EmptyState
        title="No query data yet"
        description="Clusters appear here once Search Console data has synced for this site."
      />
    );
  }

  const truncated =
    (opportunitiesQuery.data ?? []).length > CLUSTER_MAX_QUERIES;

  return (
    <div className="space-y-4">
      <Card className="border-primary/30 bg-primary/5">
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs text-muted-foreground">
            Clusters are grouped by shared significant words across queries (a
            lexical similarity check run in the browser) - not by embeddings or
            a paid clustering API.
            {truncated &&
              ` Limited to the top ${CLUSTER_MAX_QUERIES} queries by impressions to keep this fast.`}
          </p>
        </div>
      </Card>

      {clusters.length === 0 ? (
        <EmptyState title="No clusters yet" />
      ) : (
        <div className="space-y-2">
          {clusters.map((cluster) => (
            <Card key={cluster.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 p-4 text-left"
                onClick={() =>
                  setExpanded(expanded === cluster.id ? null : cluster.id)
                }
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {privacy.maskText(
                      cluster.label,
                      `kw-cluster:${cluster.id}`,
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {cluster.queries.length} quer
                    {cluster.queries.length === 1 ? "y" : "ies"} &middot;{" "}
                    {formatNumber(cluster.totalClicks)} clicks &middot;{" "}
                    {formatNumber(cluster.totalImpressions)} impressions
                    {cluster.bestPosition != null &&
                      ` · best pos. ${formatPosition(cluster.bestPosition)}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {cluster.cannibalisation && (
                    <span className="rounded border border-critical/30 bg-critical/10 px-1.5 py-0.5 text-[10px] font-medium text-critical">
                      {cluster.rankingUrls.length} URLs
                    </span>
                  )}
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                      MAPPING_TONE[cluster.mapping],
                    )}
                  >
                    {MAPPING_LABEL[cluster.mapping]}
                  </span>
                </div>
              </button>
              {expanded === cluster.id && (
                <div className="border-t border-border px-4 py-3">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1 font-medium">Query</th>
                        <th className="py-1 font-medium">Ranking URL</th>
                        <th className="py-1 text-right font-medium">Clicks</th>
                        <th className="py-1 text-right font-medium">Impr.</th>
                        <th className="py-1 text-right font-medium">Pos.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cluster.queries.map((q) => (
                        <tr key={q.query} className="border-t border-border/60">
                          <td className="max-w-[12rem] truncate py-1.5">
                            {privacy.maskText(
                              q.query,
                              `kw-cluster-q:${q.query}`,
                            )}
                          </td>
                          <td className="max-w-[12rem] truncate py-1.5 text-xs text-muted-foreground">
                            {q.rankingUrl
                              ? privacy.maskText(
                                  q.rankingUrl,
                                  `kw-cluster-url:${q.query}`,
                                )
                              : "-"}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {formatNumber(q.clicks)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                            {formatNumber(q.impressions)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {formatPosition(q.currentPosition)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
