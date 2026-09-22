import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addAiVisibilityPrompt,
  addCompetitorDomain,
  addTrackedQuery,
  addTrackedRankKeyword,
  getAiBriefing,
  getAiVisibilityObservations,
  getAiVisibilityPrompts,
  getCommonCrawlPages,
  getCommonCrawlRuns,
  getCompetitorDomains,
  getEngineQueryPositions,
  getIntegrationStatuses,
  getKeywordOpportunities,
  getObservedSerpResults,
  getPortfolioPageDaily,
  getRankSnapshots,
  getSearchAppearanceDaily,
  getSiteAuditIssues,
  getSiteAuditPages,
  getSiteAuditRuns,
  getSitePageDaily,
  getTrackedQueryHistory,
  getTrackedRankKeywords,
  getUptimeSummaries,
  recordAiVisibilityObservation,
  recordRankObservation,
  recordSerpObservation,
  removeAiVisibilityPrompt,
  removeCompetitorDomain,
  removeTrackedQuery,
  removeTrackedRankKeyword,
  triggerCommonCrawlSync,
  triggerSiteAudit,
  getSite,
  getSiteMetrics,
  getSites,
  getSyncRuns,
  getInsights,
  getSiteSearchTerms,
  getDbUsage,
  runCleanup,
  invokeManualSync,
  saveSite,
  deleteSite,
  type AiObservationInput,
  type AiPromptFormValues,
  type CompetitorDomainFormValues,
  type ManualSource,
  type RankObservationInput,
  type SerpObservationResultInput,
  type SyncRunFilters,
  type TrackedRankKeywordFormValues,
} from "@/lib/api";
import { fetchSitePagesInventory } from "@/features/keywords/site-pages-source";

// Stable query keys (brief §21) so manual sync (Phase 5) can invalidate
// precisely.
export const queryKeys = {
  insights: (days: number) => ["insights", days] as const,
  sites: ["sites"] as const,
  site: (siteId: string) => ["site", siteId] as const,
  siteMetrics: (siteId: string, days: number) =>
    ["site-metrics", siteId, days] as const,
  siteSearchTerms: (siteId: string, days: number) =>
    ["site-search-terms", siteId, days] as const,
  integrationStatuses: (siteId?: string) =>
    ["integration-statuses", siteId ?? null] as const,
  syncRuns: (filters: SyncRunFilters) => ["sync-runs", filters] as const,
  dbUsage: ["db-usage"] as const,
  trackedQueryHistory: (siteId: string, days: number) =>
    ["tracked-query-history", siteId, days] as const,
  uptime: ["uptime"] as const,
  sitePageDaily: (siteId: string, days: number) =>
    ["site-page-daily", siteId, days] as const,
  portfolioPageDaily: (days: number) => ["portfolio-page-daily", days] as const,
  keywordOpportunities: (siteId: string, days: number) =>
    ["keyword-opportunities", siteId, days] as const,
  trackedRankKeywords: (siteId: string) =>
    ["tracked-rank-keywords", siteId] as const,
  rankSnapshots: (siteId: string) => ["rank-snapshots", siteId] as const,
  competitorDomains: (siteId: string) =>
    ["competitor-domains", siteId] as const,
  observedSerpResults: (siteId: string) =>
    ["observed-serp-results", siteId] as const,
  commonCrawlPages: (domain: string) => ["common-crawl-pages", domain] as const,
  commonCrawlRuns: (domain: string) => ["common-crawl-runs", domain] as const,
  sitePagesInventory: (domain: string) =>
    ["site-pages-inventory", domain] as const,
  engineQueryPositions: (siteId: string, days: number) =>
    ["engine-query-positions", siteId, days] as const,
  siteAuditRuns: (siteId: string) => ["site-audit-runs", siteId] as const,
  siteAuditIssues: (runId: string) => ["site-audit-issues", runId] as const,
  siteAuditPages: (runId: string) => ["site-audit-pages", runId] as const,
  searchAppearanceDaily: (siteId: string, days: number) =>
    ["search-appearance-daily", siteId, days] as const,
  aiVisibilityPrompts: (siteId: string) =>
    ["ai-visibility-prompts", siteId] as const,
  aiVisibilityObservations: (siteId: string) =>
    ["ai-visibility-observations", siteId] as const,
};

export function useSites() {
  return useQuery({ queryKey: queryKeys.sites, queryFn: getSites });
}

export function useInsights(days: number) {
  return useQuery({
    queryKey: queryKeys.insights(days),
    queryFn: () => getInsights(days),
    // Keep the prior range's data on screen while a new range loads, so toggling
    // 7/30/90 doesn't flash skeletons across the whole overview.
    placeholderData: keepPreviousData,
  });
}

export function useSite(siteId: string) {
  return useQuery({
    queryKey: queryKeys.site(siteId),
    queryFn: () => getSite(siteId),
    enabled: !!siteId,
  });
}

export function useSiteMetrics(siteId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.siteMetrics(siteId, days),
    queryFn: () => getSiteMetrics(siteId, days),
    enabled: !!siteId,
  });
}

export function useSiteSearchTerms(siteId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.siteSearchTerms(siteId, days),
    queryFn: () => getSiteSearchTerms(siteId, days),
    enabled: !!siteId,
  });
}

export function useIntegrationStatuses(siteId?: string) {
  return useQuery({
    queryKey: queryKeys.integrationStatuses(siteId),
    queryFn: () => getIntegrationStatuses(siteId),
  });
}

export function useSyncRuns(filters: SyncRunFilters) {
  return useQuery({
    queryKey: queryKeys.syncRuns(filters),
    queryFn: () => getSyncRuns(filters),
  });
}

export function useDbUsage() {
  return useQuery({ queryKey: queryKeys.dbUsage, queryFn: getDbUsage });
}

/** Run or preview the retention cleanup. A real run refreshes the views it
 * touches; a dry run leaves the cache untouched. */
export function useRunCleanup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) => runCleanup(dryRun),
    onSuccess: (result) => {
      if (result.dry_run) return;
      qc.invalidateQueries({ queryKey: queryKeys.dbUsage });
      qc.invalidateQueries({ queryKey: ["insights"] });
      qc.invalidateQueries({ queryKey: ["site-metrics"] });
      qc.invalidateQueries({ queryKey: ["site-search-terms"] });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
    },
  });
}

/** Create/update a site, then refresh the lists that show it. */
export function useSaveSite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveSite,
    onSuccess: (site) => {
      qc.invalidateQueries({ queryKey: queryKeys.sites });
      qc.invalidateQueries({ queryKey: ["insights"] });
      qc.invalidateQueries({ queryKey: queryKeys.site(site.id) });
    },
  });
}

/** Delete a site, then refresh the lists. */
export function useDeleteSite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteSite,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sites });
      qc.invalidateQueries({ queryKey: ["insights"] });
    },
  });
}

/** Manual sync mutation that refreshes every view touched by a sync (§20). */
export function useManualSync(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: ManualSource) => invokeManualSync(siteId, source),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.site(siteId) });
      qc.invalidateQueries({ queryKey: ["site-metrics", siteId] });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["insights"] });
      qc.invalidateQueries({ queryKey: ["integration-statuses"] });
    },
  });
}

// V2 hooks --------------------------------------------------------------------

export function useTrackedQueryHistory(siteId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.trackedQueryHistory(siteId, days),
    queryFn: () => getTrackedQueryHistory(siteId, days),
    enabled: !!siteId,
  });
}

export function useTrackQuery(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { query: string; track: boolean }) =>
      args.track
        ? addTrackedQuery(siteId, args.query)
        : removeTrackedQuery(siteId, args.query),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracked-query-history", siteId] });
    },
  });
}

export function useUptimeSummaries() {
  return useQuery({
    queryKey: queryKeys.uptime,
    queryFn: getUptimeSummaries,
    // A new check lands at most hourly - no need to refetch aggressively.
    staleTime: 5 * 60 * 1000,
  });
}

export function useSitePageDaily(siteId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.sitePageDaily(siteId, days),
    queryFn: () => getSitePageDaily(siteId, days),
    enabled: !!siteId,
  });
}

export function usePortfolioPageDaily(days: number) {
  return useQuery({
    queryKey: queryKeys.portfolioPageDaily(days),
    queryFn: () => getPortfolioPageDaily(days),
  });
}

/** Keyword Opportunity Engine (Phase 1) - computed client-side from data
 * already fetched, so this is cheap: cached like any other query, not a new
 * provider call. */
export function useKeywordOpportunities(siteId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.keywordOpportunities(siteId, days),
    queryFn: () => getKeywordOpportunities(siteId, days),
    enabled: !!siteId,
    placeholderData: keepPreviousData,
  });
}

/** Generate an AI briefing on demand (never automatically - it costs money). */
export function useAiBriefing() {
  return useMutation({
    mutationFn: (args: { days: number; summary: Record<string, unknown> }) =>
      getAiBriefing(args.days, args.summary),
  });
}

// Phase 2: tracked rank keywords, rank history, competitors, Common Crawl ----

export function useTrackedRankKeywords(siteId: string) {
  return useQuery({
    queryKey: queryKeys.trackedRankKeywords(siteId),
    queryFn: () => getTrackedRankKeywords(siteId),
    enabled: !!siteId,
  });
}

export function useAddTrackedRankKeyword(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: TrackedRankKeywordFormValues) =>
      addTrackedRankKeyword(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.trackedRankKeywords(siteId) });
    },
  });
}

export function useRemoveTrackedRankKeyword(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeTrackedRankKeyword(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.trackedRankKeywords(siteId) });
      qc.invalidateQueries({ queryKey: queryKeys.rankSnapshots(siteId) });
    },
  });
}

/** The complete observation history for a site's tracked rank keywords -
 * never just the latest row, so lib/rank-tracking.ts can compute best/worst/
 * first-seen/movement from the full series. */
export function useRankSnapshots(siteId: string) {
  return useQuery({
    queryKey: queryKeys.rankSnapshots(siteId),
    queryFn: () => getRankSnapshots(siteId),
    enabled: !!siteId,
  });
}

export function useRecordRankObservation(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RankObservationInput) => recordRankObservation(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.rankSnapshots(siteId) });
    },
  });
}

export function useRecordSerpObservation(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      trackedRankKeywordId: string;
      results: SerpObservationResultInput[];
    }) => recordSerpObservation(args.trackedRankKeywordId, args.results),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.rankSnapshots(siteId) });
      qc.invalidateQueries({ queryKey: queryKeys.observedSerpResults(siteId) });
    },
  });
}

export function useCompetitorDomains(siteId: string) {
  return useQuery({
    queryKey: queryKeys.competitorDomains(siteId),
    queryFn: () => getCompetitorDomains(siteId),
    enabled: !!siteId,
  });
}

export function useAddCompetitorDomain(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: CompetitorDomainFormValues) =>
      addCompetitorDomain(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.competitorDomains(siteId) });
    },
  });
}

export function useRemoveCompetitorDomain(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => removeCompetitorDomain(siteId, domain),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.competitorDomains(siteId) });
    },
  });
}

export function useObservedSerpResults(siteId: string) {
  return useQuery({
    queryKey: queryKeys.observedSerpResults(siteId),
    queryFn: () => getObservedSerpResults(siteId),
    enabled: !!siteId,
  });
}

export function useCommonCrawlPages(domain: string) {
  return useQuery({
    queryKey: queryKeys.commonCrawlPages(domain),
    queryFn: () => getCommonCrawlPages(domain),
    enabled: !!domain,
  });
}

// Internal Link Engine's primary inventory (sitemap.xml + search-index.json,
// fetched directly from the browser - see site-pages-source.ts). Auto-fires
// like any other query, unlike the Common Crawl sync above which is a
// manual one-click mutation - this needs no admin action and no Supabase
// round trip, so it "just works" the moment the Opportunities page loads.
// 5-minute staleTime matches the site's own Cache-Control on
// /assets/data/* (max-age=300), so this never polls more often than the
// data itself actually changes.
export function useSitePagesInventory(domain: string) {
  return useQuery({
    queryKey: queryKeys.sitePagesInventory(domain),
    queryFn: () => fetchSitePagesInventory(domain),
    enabled: !!domain,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCommonCrawlRuns(domain: string) {
  return useQuery({
    queryKey: queryKeys.commonCrawlRuns(domain),
    queryFn: () => getCommonCrawlRuns(domain),
    enabled: !!domain,
  });
}

export function useEngineQueryPositions(siteId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.engineQueryPositions(siteId, days),
    queryFn: () => getEngineQueryPositions(siteId, days),
    enabled: !!siteId,
  });
}

/** On-demand only - never scheduled (CLAUDE.md: no high-frequency jobs). */
export function useTriggerCommonCrawlSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => triggerCommonCrawlSync(domain),
    onSuccess: (_result, domain) => {
      qc.invalidateQueries({ queryKey: queryKeys.commonCrawlPages(domain) });
      qc.invalidateQueries({ queryKey: queryKeys.commonCrawlRuns(domain) });
    },
  });
}

// Site Audit (Phase 5) --------------------------------------------------------

export function useSiteAuditRuns(siteId: string) {
  return useQuery({
    queryKey: queryKeys.siteAuditRuns(siteId),
    queryFn: () => getSiteAuditRuns(siteId),
    enabled: !!siteId,
  });
}

export function useSiteAuditIssues(runId: string) {
  return useQuery({
    queryKey: queryKeys.siteAuditIssues(runId),
    queryFn: () => getSiteAuditIssues(runId),
    enabled: !!runId,
  });
}

export function useSiteAuditPages(runId: string) {
  return useQuery({
    queryKey: queryKeys.siteAuditPages(runId),
    queryFn: () => getSiteAuditPages(runId),
    enabled: !!runId,
  });
}

// The CTR Optimizer's real page-evidence source (Phase 3): the pages from
// this site's most recent SUCCESSFUL site audit run, if one has ever been
// run - no new fetch beyond the two queries below, both already used
// elsewhere (Site Audit page). Returns undefined data (not an empty array)
// until it's known whether a successful run exists at all, so callers can
// tell "genuinely no audit yet" apart from "still loading".
export function useLatestSiteAuditPages(siteId: string) {
  const runsQuery = useSiteAuditRuns(siteId);
  const latestSuccessfulRun = runsQuery.data?.find(
    (r) => r.status === "success",
  );
  const pagesQuery = useSiteAuditPages(latestSuccessfulRun?.id ?? "");
  return {
    isLoading:
      runsQuery.isLoading || (!!latestSuccessfulRun && pagesQuery.isLoading),
    hasSuccessfulRun: !!latestSuccessfulRun,
    runFinishedAt: latestSuccessfulRun?.finished_at ?? null,
    pages: latestSuccessfulRun ? pagesQuery.data : undefined,
  };
}

/** On-demand only - never scheduled. Bounded BFS crawl of the site's own
 * domain (see supabase/functions/site-audit-crawl). */
export function useTriggerSiteAudit(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => triggerSiteAudit(siteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.siteAuditRuns(siteId) });
    },
  });
}

// AI Visibility (Phase 8 / "AI Search source coverage") ---------------------

export function useSearchAppearanceDaily(siteId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.searchAppearanceDaily(siteId, days),
    queryFn: () => getSearchAppearanceDaily(siteId, days),
    enabled: !!siteId,
  });
}

export function useAiVisibilityPrompts(siteId: string) {
  return useQuery({
    queryKey: queryKeys.aiVisibilityPrompts(siteId),
    queryFn: () => getAiVisibilityPrompts(siteId),
    enabled: !!siteId,
  });
}

export function useAddAiVisibilityPrompt(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: AiPromptFormValues) => addAiVisibilityPrompt(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.aiVisibilityPrompts(siteId) });
    },
  });
}

export function useRemoveAiVisibilityPrompt(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeAiVisibilityPrompt(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.aiVisibilityPrompts(siteId) });
    },
  });
}

export function useAiVisibilityObservations(siteId: string) {
  return useQuery({
    queryKey: queryKeys.aiVisibilityObservations(siteId),
    queryFn: () => getAiVisibilityObservations(siteId),
    enabled: !!siteId,
  });
}

export function useRecordAiVisibilityObservation(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AiObservationInput) =>
      recordAiVisibilityObservation(input),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.aiVisibilityObservations(siteId),
      });
    },
  });
}
