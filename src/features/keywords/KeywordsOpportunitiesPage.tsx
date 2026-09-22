import { Fragment, useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { Wand2 } from "lucide-react";
import {
  useCommonCrawlPages,
  useKeywordOpportunities,
  useSitePagesInventory,
  useSites,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { OpportunityBadgeList } from "@/features/keywords/OpportunityBadges";
import { ScoreBar, ScoreFactorList } from "@/features/keywords/ScoreBar";
import { FixPromptModal } from "@/features/keywords/FixPromptModal";
import { buildFixPrompt } from "@/features/keywords/generateFixPrompt";
import { diagnoseOpportunity } from "@/features/keywords/opportunity-diagnosis";
import {
  findInternalLinkOpportunities,
  type CandidatePage,
  type InternalLinkSuggestion,
} from "@/features/keywords/internal-link-engine";
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
  // Already fetched by KeywordsLayout (same query key) - just reading the
  // domain/name for the generated prompt, not a second network request.
  const sitesQuery = useSites();
  const site = sitesQuery.data?.find((s) => s.id === siteId);
  // Internal Link Engine (Phase 2) - primary inventory is this site's own
  // current sitemap.xml + search-index.json, fetched directly from the
  // browser (see site-pages-source.ts) and auto-loaded, no admin action
  // needed. Common Crawl is optional supplemental/history data only - the
  // engine works fully without it.
  const sitePagesQuery = useSitePagesInventory(site?.domain ?? "");
  const commonCrawlQuery = useCommonCrawlPages(site?.domain ?? "");
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fixPromptRow, setFixPromptRow] =
    useState<KeywordOpportunityRow | null>(null);

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

  // "Prefer pages with existing search visibility/authority where
  // available" - every ranking URL already seen among this site's own
  // opportunities is real, already-computed evidence of visibility, not a
  // new fetch or an invented authority score.
  const searchVisibleUrls = useMemo(
    () =>
      new Set(rows.map((r) => r.rankingUrl).filter((u): u is string => !!u)),
    [rows],
  );

  // undefined = not analysed (no target URL, or the site's own page
  // inventory hasn't loaded yet this run) - rendered as an honest "not
  // analysed" message, never as zero relevant pages. Common Crawl data is
  // merged in only when it happens to already be loaded - it's never
  // required and this never waits on it.
  function suggestionsFor(
    row: KeywordOpportunityRow,
  ): InternalLinkSuggestion[] | undefined {
    if (!row.rankingUrl) return undefined;
    const primaryPages = sitePagesQuery.data?.pages;
    if (!primaryPages) return undefined;
    const supplementalPages: CandidatePage[] = (commonCrawlQuery.data ?? [])
      .filter((p) => p.is_active)
      .map((p) => ({
        url: p.url,
        title: p.title,
        extraText: null,
        source: "common-crawl" as const,
      }));
    return findInternalLinkOpportunities({
      targetUrl: row.rankingUrl,
      targetQuery: row.query,
      primaryPages,
      supplementalPages,
      pagesWithSearchVisibility: searchVisibleUrls,
      weaklyLinkedTargetUrls: sitePagesQuery.data?.weaklyLinkedUrls,
    });
  }

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
                  <th className="px-2 py-2 font-medium">Fix</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const diagnosis = diagnoseOpportunity(row);
                  return (
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
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFixPromptRow(row);
                            }}
                            title="Generate Fix Prompt"
                            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary"
                          >
                            <Wand2 className="h-3 w-3" />
                            Fix
                          </button>
                        </td>
                      </tr>
                      {expanded === row.query && (
                        <tr className="border-b border-border bg-muted/20 last:border-0">
                          <td colSpan={13} className="px-4 py-3">
                            <div className="grid gap-4 md:grid-cols-2">
                              <div>
                                <p className="mb-1 text-xs font-semibold">
                                  Measurable problem
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  {diagnosis.seoWeakness}
                                </p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {diagnosis.ctrWeakness}
                                </p>
                                <p className="mb-1 mt-3 text-xs font-semibold">
                                  Already working - preserve this
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  {diagnosis.preserve}
                                </p>
                                <p className="mb-1 mt-3 text-xs font-semibold">
                                  Recommended priority action
                                </p>
                                <p className="text-sm font-medium text-foreground">
                                  {diagnosis.priorityAction}
                                </p>
                                {row.competingUrls.length >= 2 && (
                                  <div className="mt-2">
                                    <p className="text-xs font-semibold">
                                      Competing URLs
                                    </p>
                                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                                      {row.competingUrls.map((u) => (
                                        <li key={u} className="truncate">
                                          {privacy.maskText(
                                            u,
                                            `kw-opp-cu:${u}`,
                                          )}
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
                            <InternalLinkOpportunitiesPanel
                              suggestions={suggestionsFor(row)}
                              maskUrl={(u) =>
                                privacy.maskText(u, `kw-opp-link:${u}`)
                              }
                            />
                            <div className="mt-3 flex justify-end">
                              <button
                                type="button"
                                onClick={() => setFixPromptRow(row)}
                                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary"
                              >
                                <Wand2 className="h-3 w-3" />
                                Generate Fix Prompt
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {fixPromptRow && (
        <FixPromptModal
          title={`"${fixPromptRow.query}" - ${site?.name ?? "this site"}`}
          prompt={buildFixPrompt(
            {
              domain: site?.domain ?? "unknown",
              name: site?.name ?? "this site",
            },
            fixPromptRow,
            suggestionsFor(fixPromptRow),
          )}
          onClose={() => setFixPromptRow(null)}
        />
      )}
    </div>
  );
}

/**
 * Phase 2, Internal Link Engine - shown inside each expanded opportunity.
 * undefined suggestions = not analysed yet (no page inventory synced, or no
 * target URL); an empty array = genuinely analysed and nothing relevant
 * found. Never invents a link status - see internal-link-engine.ts.
 */
function InternalLinkOpportunitiesPanel({
  suggestions,
  maskUrl,
}: {
  suggestions: InternalLinkSuggestion[] | undefined;
  maskUrl: (url: string) => string;
}) {
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-1 text-xs font-semibold">Internal link opportunities</p>
      {suggestions === undefined ? (
        <p className="text-xs text-muted-foreground">
          Not analysed - this site&apos;s current sitemap/search index
          hasn&apos;t loaded yet, or this query has no ranking URL to link
          to.
        </p>
      ) : suggestions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No genuinely relevant existing page found - nothing is suggested
          rather than linking from an unrelated page.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Source page</th>
                <th className="py-1 pr-2 font-medium">Suggested anchor</th>
                <th className="py-1 pr-2 font-medium">Reason / relevance</th>
                <th className="py-1 pr-2 font-medium">Visibility</th>
                <th className="py-1 pr-2 font-medium">Existing link</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.sourceUrl} className="border-t border-border/60">
                  <td className="max-w-[14rem] truncate py-1 pr-2">
                    {maskUrl(s.sourceUrl)}
                  </td>
                  <td className="max-w-[10rem] truncate py-1 pr-2">
                    {s.suggestedAnchor}
                  </td>
                  <td className="max-w-[12rem] truncate py-1 pr-2 text-muted-foreground">
                    {s.matchedTerms.join(", ")}
                  </td>
                  <td className="py-1 pr-2 text-muted-foreground">
                    {s.hasSearchVisibility ? "Ranks already" : "Unknown"}
                  </td>
                  <td className="max-w-[10rem] truncate py-1 pr-2 text-muted-foreground">
                    {s.targetLinkStatus === "target-weakly-linked"
                      ? "Target weakly linked"
                      : s.targetLinkStatus === "target-well-linked"
                        ? "Target already well linked"
                        : "Existing link not verified"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
