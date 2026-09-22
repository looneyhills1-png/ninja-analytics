import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Wand2 } from "lucide-react";
import {
  useKeywordOpportunities,
  useLatestSiteAuditPages,
  useSites,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { FixPromptModal } from "@/features/keywords/FixPromptModal";
import { buildFixPrompt } from "@/features/keywords/generateFixPrompt";
import {
  findCtrOpportunities,
  type CtrOpportunity,
  type SiteAuditPageEvidence,
} from "@/features/keywords/ctr-optimizer";
import { pathOf } from "@/lib/url-path";
import { formatCtr, formatNumber, formatPosition } from "@/lib/format";
import { cn } from "@/lib/utils";

type CtrSortKey = "gap" | "missedClicks" | "impressions" | "position";

const SORTERS: Record<CtrSortKey, (o: CtrOpportunity) => number> = {
  gap: (o) => o.ctrGapAbsolute,
  missedClicks: (o) => o.estimatedMissedClicks,
  impressions: (o) => o.impressions,
  position: (o) => -o.currentPosition, // best (lowest number) position first
};

/**
 * CTR Optimizer (Phase 3) - the "dedicated CTR opportunities" view: every
 * row here already ranks positions 1-10 with meaningful impressions but is
 * converting materially fewer clicks than expected for that position - the
 * exact opposite priority to a broad content rewrite, since Google already
 * places the page there for this query. See ctr-optimizer.ts for the
 * detection/diagnosis math (fully documented, nothing invented) and
 * ctr-benchmark.ts for the expected-CTR curve (this site's own observed
 * rate where there's enough first-party volume, a labelled heuristic
 * otherwise).
 */
export function CtrOptimizerPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);
  const sitesQuery = useSites();
  const site = sitesQuery.data?.find((s) => s.id === siteId);
  // Real title/meta evidence, if this site has ever had a Site Audit run -
  // never required, never guessed when absent (see pageEvidenceByUrl).
  const auditQuery = useLatestSiteAuditPages(siteId);
  const [sortKey, setSortKey] = useState<CtrSortKey>("gap");
  const [fixPromptOpportunity, setFixPromptOpportunity] =
    useState<CtrOpportunity | null>(null);

  const rows = useMemo(
    () => opportunitiesQuery.data ?? [],
    [opportunitiesQuery.data],
  );
  const rowsByQuery = useMemo(
    () => new Map(rows.map((r) => [r.query, r])),
    [rows],
  );

  const pageEvidenceByUrl = useMemo(() => {
    const map = new Map<string, SiteAuditPageEvidence>();
    for (const p of auditQuery.pages ?? []) {
      map.set(pathOf(p.url), {
        title: p.title,
        titleLength: p.title_length,
        metaDescription: p.meta_description,
        metaDescriptionLength: p.meta_description_length,
        h1Count: p.h1_count,
      });
    }
    return map;
  }, [auditQuery.pages]);

  const opportunities = useMemo(
    () => findCtrOpportunities({ rows, pageEvidenceByUrl }),
    [rows, pageEvidenceByUrl],
  );

  const sorted = useMemo(
    () =>
      [...opportunities].sort(
        (a, b) => SORTERS[sortKey](b) - SORTERS[sortKey](a),
      ),
    [opportunities, sortKey],
  );

  if (opportunitiesQuery.isLoading) return <Skeleton className="h-96" />;
  if (opportunitiesQuery.isError)
    return <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No query data yet"
        description="CTR opportunities appear here once Search Console data has synced for this site."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Queries already ranking on page 1 (positions 1-10) with meaningful
          impressions but a CTR materially below what's expected for that
          position - prioritised above broad content rewrites, since the ranking
          itself is evidence the page already matches search intent reasonably
          well.
          {!auditQuery.hasSuccessfulRun && (
            <>
              {" "}
              Run a Site Audit (Site Audit page) to see real captured title/meta
              evidence and sharper, evidence-based diagnosis here - without one,
              page evidence is honestly marked as not inspected rather than
              guessed.
            </>
          )}
        </p>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as CtrSortKey)}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm"
        >
          <option value="gap">Sort: Biggest CTR gap</option>
          <option value="missedClicks">
            Sort: Most missed-click opportunity
          </option>
          <option value="impressions">Sort: Highest impressions</option>
          <option value="position">Sort: Best ranking position</option>
        </select>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          title="No CTR opportunities right now"
          description="No page-1 query is converting materially fewer clicks than expected for its position in the current window."
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Query</th>
                  <th className="px-2 py-2 font-medium">Ranking URL</th>
                  <th className="px-2 py-2 text-right font-medium">Pos.</th>
                  <th className="px-2 py-2 text-right font-medium">Impr.</th>
                  <th className="px-2 py-2 text-right font-medium">Clicks</th>
                  <th className="px-2 py-2 text-right font-medium">
                    Actual CTR
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    Expected CTR
                  </th>
                  <th className="px-2 py-2 text-right font-medium">Gap</th>
                  <th className="px-2 py-2 text-right font-medium">
                    Est. missed clicks
                  </th>
                  <th className="px-2 py-2 font-medium">Diagnosis</th>
                  <th className="px-2 py-2 font-medium">Fix</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((o) => (
                  <tr
                    key={o.query}
                    className="border-b border-border align-top last:border-0"
                  >
                    <td className="max-w-[14rem] truncate px-3 py-2">
                      {privacy.maskText(o.query, `ctr:${o.query}`)}
                    </td>
                    <td className="max-w-[12rem] truncate px-2 py-2 text-xs text-muted-foreground">
                      {o.rankingUrl
                        ? privacy.maskText(o.rankingUrl, `ctr-url:${o.query}`)
                        : "-"}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatPosition(o.currentPosition)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatNumber(o.impressions)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatNumber(o.clicks)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatCtr(o.actualCtr)}
                    </td>
                    <td
                      className="px-2 py-2 text-right tabular-nums text-muted-foreground"
                      title={
                        o.expectedCtrSource === "observed"
                          ? `Observed from this site's own ${o.expectedCtrSampleImpressions ?? 0} impressions across ${o.expectedCtrSampleQueries ?? 0} queries at this position`
                          : "Documented generic industry-pattern heuristic curve - not enough first-party data yet at this position"
                      }
                    >
                      {formatCtr(o.expectedCtr)}{" "}
                      <span
                        className={cn(
                          "text-[10px]",
                          o.expectedCtrSource === "observed"
                            ? "text-success"
                            : "text-muted-foreground",
                        )}
                      >
                        ({o.expectedCtrSource})
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums font-medium text-critical">
                      {formatCtr(o.ctrGapAbsolute)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      ~{formatNumber(o.estimatedMissedClicks)}
                    </td>
                    <td className="max-w-[18rem] px-2 py-2 text-xs text-muted-foreground">
                      <details>
                        <summary className="cursor-pointer text-foreground">
                          {o.pageEvidence.source === "site-audit"
                            ? "Evidence-based diagnosis"
                            : "Not inspected - view details"}
                        </summary>
                        <div className="mt-1 space-y-1">
                          <p>
                            <strong>Title:</strong>{" "}
                            {o.pageEvidence.title ?? "Not captured"}
                          </p>
                          <p>
                            <strong>Meta:</strong>{" "}
                            {o.pageEvidence.metaDescription ?? "Not captured"}
                          </p>
                          <p>
                            <strong>H1 count:</strong>{" "}
                            {o.pageEvidence.h1Count ?? "Not captured"} (H1 text
                            itself is never captured by this app)
                          </p>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4">
                            {o.diagnosisFlags.map((f) => (
                              <li key={f.weakness}>
                                <span className="font-medium">
                                  {f.weakness}
                                </span>{" "}
                                [{f.confidence}]: {f.explanation}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 font-medium text-foreground">
                            {o.recommendedChange}
                          </p>
                        </div>
                      </details>
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => setFixPromptOpportunity(o)}
                        title="Generate CTR Fix Prompt"
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary"
                      >
                        <Wand2 className="h-3 w-3" />
                        Fix
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {fixPromptOpportunity &&
        (() => {
          // A CtrOpportunity is always derived from a row already in `rows`
          // (see ctr-optimizer.ts), so this lookup is safe within the same
          // render's data.
          const row = rowsByQuery.get(fixPromptOpportunity.query);
          if (!row) return null;
          return (
            <FixPromptModal
              title={`"${fixPromptOpportunity.query}" - CTR fix - ${site?.name ?? "this site"}`}
              prompt={buildFixPrompt(
                {
                  domain: site?.domain ?? "unknown",
                  name: site?.name ?? "this site",
                },
                row,
                undefined,
                fixPromptOpportunity,
              )}
              onClose={() => setFixPromptOpportunity(null)}
            />
          );
        })()}
    </div>
  );
}
