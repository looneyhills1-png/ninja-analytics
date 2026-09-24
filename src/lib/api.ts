import { subDays, format } from "date-fns";
import { supabase } from "@/lib/supabase";
import { fetchAllPages } from "@/lib/paginate";
import { computeInsights, type InsightsResult } from "@/lib/insights";
import { aggregateBreakdown, type TermRow } from "@/lib/search-terms";
import {
  computeKeywordOpportunities,
  type KeywordOpportunityRow,
  type QueryDailyRow,
  type QueryPageDailyRow,
} from "@/lib/keyword-opportunities";
import {
  buildExportComputed,
  type PortfolioExportComputed,
} from "@/lib/portfolio-export";
import type {
  AiVisibilityObservation,
  BingAiCitedPage,
  BingAiPerformanceSnapshot,
  AiVisibilityPrompt,
  AiVisibilitySource,
  AnalyticsDaily,
  CommonCrawlPage,
  CommonCrawlRun,
  CompetitorDomain,
  GscCoverageSnapshot,
  IntegrationStatus,
  ObservedSerpResult,
  RankDevice,
  RankSnapshot,
  SearchAppearanceDaily,
  SearchDaily,
  SearchEngine,
  SearchPageDaily,
  SearchQueryDaily,
  Site,
  SiteAuditIssue,
  SiteAuditPage,
  SiteAuditRun,
  SyncRun,
  SyncSource,
  SyncStatus,
  TrackedQuery,
  TrackedRankKeyword,
  TriggerType,
  UptimeCheck,
  UrlInspection,
  UrlInspectionHistory,
} from "@/types/database";

// Centralized data access. UI components never call supabase directly - they
// go through these typed functions (and the hooks that wrap them). Multi-row
// metric reads use fetchAllPages (see lib/paginate) to page past PostgREST's
// 1000-row cap rather than silently truncating the newest data.

export interface SiteWithStatuses extends Site {
  statuses: IntegrationStatus[];
}

function groupStatuses(
  statuses: IntegrationStatus[],
): Map<string, IntegrationStatus[]> {
  const map = new Map<string, IntegrationStatus[]>();
  for (const s of statuses) {
    const list = map.get(s.site_id) ?? [];
    list.push(s);
    map.set(s.site_id, list);
  }
  return map;
}

export async function getSites(): Promise<SiteWithStatuses[]> {
  const [sitesRes, statusRes] = await Promise.all([
    supabase.from("sites").select("*").order("name"),
    supabase.from("integration_status").select("*"),
  ]);
  if (sitesRes.error) throw sitesRes.error;
  if (statusRes.error) throw statusRes.error;

  const byId = groupStatuses(statusRes.data ?? []);
  return (sitesRes.data ?? []).map((site) => ({
    ...site,
    statuses: byId.get(site.id) ?? [],
  }));
}

export async function getSite(
  siteId: string,
): Promise<SiteWithStatuses | null> {
  const [siteRes, statusRes] = await Promise.all([
    supabase.from("sites").select("*").eq("id", siteId).maybeSingle(),
    supabase.from("integration_status").select("*").eq("site_id", siteId),
  ]);
  if (siteRes.error) throw siteRes.error;
  if (statusRes.error) throw statusRes.error;
  if (!siteRes.data) return null;
  return { ...siteRes.data, statuses: statusRes.data ?? [] };
}

export interface SiteMetrics {
  analytics: AnalyticsDaily[];
  search: SearchDaily[];
}

/**
 * Fetch enough history (2× the window) so the UI can compare the current period
 * against the immediately preceding one.
 */
export async function getSiteMetrics(
  siteId: string,
  days: number,
): Promise<SiteMetrics> {
  const since = format(subDays(new Date(), days * 2), "yyyy-MM-dd");
  const [analytics, search] = await Promise.all([
    fetchAllPages<AnalyticsDaily>(() =>
      supabase
        .from("analytics_daily")
        .select("*")
        .eq("site_id", siteId)
        .gte("metric_date", since)
        .order("metric_date"),
    ),
    fetchAllPages<SearchDaily>(() =>
      supabase
        .from("search_daily")
        .select("*")
        .eq("site_id", siteId)
        .gte("metric_date", since)
        .order("metric_date"),
    ),
  ]);
  return { analytics, search };
}

export interface SiteSearchTerms {
  queries: TermRow[];
  pages: TermRow[];
  coverage: {
    queries: DateCoverage;
    pages: DateCoverage;
  };
}

export interface DateCoverage {
  firstDate: string | null;
  lastDate: string | null;
  daysWithRows: number;
  rows: number;
}

function getDateCoverage(rows: Array<{ metric_date: string }>): DateCoverage {
  if (rows.length === 0) {
    return { firstDate: null, lastDate: null, daysWithRows: 0, rows: 0 };
  }
  const dates = [...new Set(rows.map((row) => row.metric_date))].sort();
  return {
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    daysWithRows: dates.length,
    rows: rows.length,
  };
}

/** Top search queries and pages for a site over the window, with click deltas. */
export async function getSiteSearchTerms(
  siteId: string,
  days: number,
): Promise<SiteSearchTerms> {
  const since = format(subDays(new Date(), days * 2), "yyyy-MM-dd");
  type QueryRow = {
    metric_date: string;
    query: string;
    clicks: number;
    impressions: number;
    average_position: number | null;
  };
  type PageRow = {
    metric_date: string;
    page: string;
    clicks: number;
    impressions: number;
    average_position: number | null;
  };
  const [queryRows, pageRows] = await Promise.all([
    fetchAllPages<QueryRow>(() =>
      supabase
        .from("search_query_daily")
        .select("metric_date, query, clicks, impressions, average_position")
        .eq("site_id", siteId)
        .gte("metric_date", since)
        .order("metric_date"),
    ),
    fetchAllPages<PageRow>(() =>
      supabase
        .from("search_page_daily")
        .select("metric_date, page, clicks, impressions, average_position")
        .eq("site_id", siteId)
        .gte("metric_date", since)
        .order("metric_date"),
    ),
  ]);

  return {
    queries: aggregateBreakdown(
      queryRows.map((r) => ({ ...r, key: r.query })),
      days,
    ),
    pages: aggregateBreakdown(
      pageRows.map((r) => ({ ...r, key: r.page })),
      days,
    ),
    coverage: {
      queries: getDateCoverage(queryRows),
      pages: getDateCoverage(pageRows),
    },
  };
}

// Keyword Intelligence / Opportunity Engine (Phase 1) --------------------------
/**
 * Everything the Keyword Opportunity Engine needs for one site: Google query
 * history (for trend/position/CTR), the query+page breakdown (for the real
 * ranking URL and cannibalisation), and Bing query history (corroboration
 * only). All three tables already exist for GSC/Bing sync - no new provider
 * call. `days*2` of history matches every other current/previous comparison
 * in this app (see getSiteSearchTerms).
 */
export async function getKeywordOpportunities(
  siteId: string,
  days: number,
): Promise<KeywordOpportunityRow[]> {
  const since = format(subDays(new Date(), days * 2), "yyyy-MM-dd");
  const site = await getSite(siteId);
  if (!site) return [];

  const [queryRows, bingQueryRows, queryPageRows] = await Promise.all([
    fetchAllPages<QueryDailyRow>(() =>
      supabase
        .from("search_query_daily")
        .select(
          "metric_date, query, clicks, impressions, ctr, average_position",
        )
        .eq("site_id", siteId)
        .eq("engine", "google")
        .gte("metric_date", since)
        .order("metric_date"),
    ),
    fetchAllPages<QueryDailyRow>(() =>
      supabase
        .from("search_query_daily")
        .select(
          "metric_date, query, clicks, impressions, ctr, average_position",
        )
        .eq("site_id", siteId)
        .eq("engine", "bing")
        .gte("metric_date", since)
        .order("metric_date"),
    ),
    fetchAllPages<QueryPageDailyRow>(() =>
      supabase
        .from("search_query_page_daily")
        .select("metric_date, query, page, clicks, impressions")
        .eq("site_id", siteId)
        .eq("engine", "google")
        .gte("metric_date", since)
        .order("metric_date"),
    ),
  ]);

  return computeKeywordOpportunities({
    site: { domain: site.domain, name: site.name },
    queryRows,
    bingQueryRows,
    queryPageRows,
    days,
  });
}

export async function getIntegrationStatuses(
  siteId?: string,
): Promise<IntegrationStatus[]> {
  let query = supabase.from("integration_status").select("*");
  if (siteId) query = query.eq("site_id", siteId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export interface SyncRunFilters {
  siteId?: string;
  source?: SyncSource;
  status?: SyncStatus;
  triggerType?: TriggerType;
  since?: string; // yyyy-MM-dd
  limit?: number;
}

export interface SyncRunRow extends SyncRun {
  site_name: string;
  site_domain: string;
}

export async function getSyncRuns(
  filters: SyncRunFilters = {},
): Promise<SyncRunRow[]> {
  let query = supabase
    .from("sync_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(filters.limit ?? 100);

  if (filters.siteId) query = query.eq("site_id", filters.siteId);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.triggerType)
    query = query.eq("trigger_type", filters.triggerType);
  if (filters.since) query = query.gte("started_at", filters.since);

  const [runsRes, sitesRes] = await Promise.all([
    query,
    supabase.from("sites").select("id, name, domain"),
  ]);
  if (runsRes.error) throw runsRes.error;
  if (sitesRes.error) throw sitesRes.error;

  const sites = new Map((sitesRes.data ?? []).map((s) => [s.id, s] as const));
  return (runsRes.data ?? []).map((run) => ({
    ...run,
    site_name: sites.get(run.site_id)?.name ?? "Unknown site",
    site_domain: sites.get(run.site_id)?.domain ?? "",
  }));
}

// Manual sync -----------------------------------------------------------------
export type ManualSource = SyncSource | "all" | "uptime";

export interface ManualSyncOutcome {
  source: SyncSource;
  status: "success" | "partial" | "failed" | "conflict" | "skipped";
  runId?: string;
  rowsWritten?: number;
}

/** Uptime has no sync_runs lifecycle - "all" and "uptime" return this
 * alongside `runs` instead of adding a fourth ManualSyncOutcome shape. */
export interface ManualUptimeResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface ManualSyncResult {
  runs: ManualSyncOutcome[];
  uptime?: ManualUptimeResult;
}

export class ManualSyncError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ManualSyncError";
  }
}

/**
 * Invoke the manual-sync Edge Function. The browser only sends a site id and a
 * source - the function loads the site and verifies admin + aal2 server-side.
 */
export async function invokeManualSync(
  siteId: string,
  source: ManualSource,
): Promise<ManualSyncResult> {
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean;
    runs: ManualSyncOutcome[];
    uptime?: ManualUptimeResult;
  }>("manual-sync", { body: { siteId, source } });

  if (error) {
    const ctx = (error as { context?: Response }).context;
    let status: number | undefined;
    let code = "error";
    let message = "Sync request failed.";
    if (ctx && typeof ctx.json === "function") {
      status = ctx.status;
      try {
        const payload = (await ctx.clone().json()) as {
          error?: string;
          message?: string;
        };
        code = payload.error ?? code;
        message = payload.message ?? message;
      } catch {
        // non-JSON body - keep generic message
      }
    }
    throw new ManualSyncError(code, message, status);
  }

  return { runs: data?.runs ?? [], uptime: data?.uptime };
}

// Site management -------------------------------------------------------------
export interface SiteFormValues {
  name: string;
  domain: string;
  website_url: string;
  gsc_property: string;
  ga4_property_id: string;
  bing_site_url: string;
  is_active: boolean;
}

export class SaveSiteError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "SaveSiteError";
  }
}

/** Create or update a site via the manage-sites Edge Function (admin + aal2
 * verified server-side; the browser holds no write policies). */
export async function saveSite(args: {
  action: "create" | "update";
  id?: string;
  values: SiteFormValues;
}): Promise<Site> {
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean;
    site: Site;
  }>("manage-sites", {
    body: { action: args.action, id: args.id, site: args.values },
  });

  if (error) {
    const ctx = (error as { context?: Response }).context;
    let status: number | undefined;
    let code = "error";
    let message = "Could not save the site.";
    if (ctx && typeof ctx.json === "function") {
      status = ctx.status;
      try {
        const payload = (await ctx.clone().json()) as {
          error?: string;
          message?: string;
        };
        code = payload.error ?? code;
        message = payload.message ?? message;
      } catch {
        // keep generic message
      }
    }
    throw new SaveSiteError(code, message, status);
  }

  return data!.site;
}

/** Delete a site (cascades to its metrics, history, and integration status). */
export async function deleteSite(id: string): Promise<void> {
  const { error } = await supabase.functions.invoke("manage-sites", {
    body: { action: "delete", id },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let status: number | undefined;
    let message = "Could not delete the site.";
    if (ctx && typeof ctx.json === "function") {
      status = ctx.status;
      try {
        const payload = (await ctx.clone().json()) as { message?: string };
        message = payload.message ?? message;
      } catch {
        // keep generic message
      }
    }
    throw new SaveSiteError("delete_failed", message, status);
  }
}

// Portfolio overview ----------------------------------------------------------
/**
 * The full overview payload: the computed insights model plus the per-site
 * integration status list the health table needs. Both are derived from the
 * same fetch so the Overview page only makes one round trip.
 */
export interface InsightsWithSites extends InsightsResult {
  sitesWithStatuses: SiteWithStatuses[];
  /** The raw daily rows behind the computation - already fetched, kept so
   * downstream features can reuse them. */
  raw: { analytics: AnalyticsDaily[]; search: SearchDaily[] };
}

/**
 * Load every site's metrics for the window and compute the full insights model
 * (portfolio KPIs, movers, opportunities, anomalies, coverage, action items),
 * plus the site+status list for the integration-health table.
 */
export async function getInsights(days: number): Promise<InsightsWithSites> {
  const since = format(subDays(new Date(), days * 2), "yyyy-MM-dd");
  const [sitesRes, statusRes, analytics, search] = await Promise.all([
    supabase.from("sites").select("*").order("name"),
    supabase.from("integration_status").select("*"),
    fetchAllPages<AnalyticsDaily>(() =>
      supabase
        .from("analytics_daily")
        .select("*")
        .gte("metric_date", since)
        .order("metric_date"),
    ),
    fetchAllPages<SearchDaily>(() =>
      supabase
        .from("search_daily")
        .select("*")
        .gte("metric_date", since)
        .order("metric_date"),
    ),
  ]);
  if (sitesRes.error) throw sitesRes.error;
  if (statusRes.error) throw statusRes.error;

  const sites = sitesRes.data ?? [];
  const statuses = statusRes.data ?? [];
  const byId = groupStatuses(statuses);

  return {
    ...computeInsights({ sites, statuses, analytics, search, days }),
    sitesWithStatuses: sites.map((site) => ({
      ...site,
      statuses: byId.get(site.id) ?? [],
    })),
    raw: { analytics, search },
  };
}

// Full data export ------------------------------------------------------------
export interface PortfolioDataExport {
  generated_at: string;
  schema_version: 2;
  retention: {
    analytics_daily: "540 days";
    search_daily: "540 days";
    search_query_daily: "210 days";
    search_page_daily: "210 days";
    sync_runs: "120 days";
    uptime_checks: "90 days";
  };
  row_counts: Record<keyof PortfolioDataExport["tables"], number>;
  tables: {
    sites: Site[];
    integration_status: IntegrationStatus[];
    analytics_daily: AnalyticsDaily[];
    search_daily: SearchDaily[];
    search_query_daily: SearchQueryDaily[];
    search_page_daily: SearchPageDaily[];
    sync_runs: SyncRun[];
    tracked_queries: TrackedQuery[];
    uptime_checks: UptimeCheck[];
  };
  /**
   * Derived intelligence an AI agent would otherwise have to recompute from
   * the raw tables above: portfolio KPIs/movers/anomalies at three windows,
   * per-site and portfolio-wide traffic forecasts, and the content-decay
   * refresh queue. Forecast summaries omit their observed series
   * deliberately - that data is already in `tables`, so repeating it here
   * would only bloat the file.
   */
  computed: PortfolioExportComputed;
}

/** Export every readable portfolio table, plus derived insights/forecasts, as
 * an agent-friendly JSON bundle. */
export async function getPortfolioDataExport(): Promise<PortfolioDataExport> {
  const [
    sitesRes,
    statusRes,
    analyticsDaily,
    searchDaily,
    searchQueryDaily,
    searchPageDaily,
    syncRuns,
    trackedQueriesRes,
    uptimeChecks,
  ] = await Promise.all([
    supabase.from("sites").select("*").order("name"),
    supabase.from("integration_status").select("*").order("site_id"),
    fetchAllPages<AnalyticsDaily>(() =>
      supabase
        .from("analytics_daily")
        .select("*")
        .order("site_id")
        .order("metric_date"),
    ),
    fetchAllPages<SearchDaily>(() =>
      supabase
        .from("search_daily")
        .select("*")
        .order("site_id")
        .order("engine")
        .order("metric_date"),
    ),
    fetchAllPages<SearchQueryDaily>(() =>
      supabase
        .from("search_query_daily")
        .select("*")
        .order("site_id")
        .order("engine")
        .order("metric_date"),
    ),
    fetchAllPages<SearchPageDaily>(() =>
      supabase
        .from("search_page_daily")
        .select("*")
        .order("site_id")
        .order("engine")
        .order("metric_date"),
    ),
    fetchAllPages<SyncRun>(() =>
      supabase
        .from("sync_runs")
        .select("*")
        .order("started_at", { ascending: false }),
    ),
    supabase.from("tracked_queries").select("*").order("site_id"),
    fetchAllPages<UptimeCheck>(() =>
      supabase
        .from("uptime_checks")
        .select("*")
        .order("checked_at", { ascending: false }),
    ),
  ]);

  if (sitesRes.error) throw sitesRes.error;
  if (statusRes.error) throw statusRes.error;
  if (trackedQueriesRes.error) throw trackedQueriesRes.error;

  const sites = sitesRes.data ?? [];
  const statuses = statusRes.data ?? [];

  const tables = {
    sites,
    integration_status: statuses,
    analytics_daily: analyticsDaily,
    search_daily: searchDaily,
    search_query_daily: searchQueryDaily,
    search_page_daily: searchPageDaily,
    sync_runs: syncRuns,
    tracked_queries: trackedQueriesRes.data ?? [],
    uptime_checks: uptimeChecks,
  };

  const computed = buildExportComputed({
    sites,
    statuses,
    analytics: analyticsDaily,
    search: searchDaily,
    searchPage: searchPageDaily,
  });

  return {
    generated_at: new Date().toISOString(),
    schema_version: 2,
    retention: {
      analytics_daily: "540 days",
      search_daily: "540 days",
      search_query_daily: "210 days",
      search_page_daily: "210 days",
      sync_runs: "120 days",
      uptime_checks: "90 days",
    },
    row_counts: Object.fromEntries(
      Object.entries(tables).map(([table, rows]) => [table, rows.length]),
    ) as PortfolioDataExport["row_counts"],
    tables,
    computed,
  };
}

// Database usage & maintenance ------------------------------------------------
export interface DbUsageTable {
  name: string;
  total_bytes: number;
  row_estimate: number;
}

export interface DbUsage {
  captured_at: string;
  database_bytes: number;
  tables: DbUsageTable[];
}

/** Database size + per-table sizes via the admin-guarded get_db_usage() RPC. */
export async function getDbUsage(): Promise<DbUsage> {
  const { data, error } = await supabase.rpc("get_db_usage");
  if (error) throw error;
  return data as unknown as DbUsage;
}

export interface CleanupResult {
  dry_run: boolean;
  executed_at: string;
  cutoffs: { daily: string; search_terms: string; sync_runs: string };
  deleted: {
    analytics_daily: number;
    search_daily: number;
    search_query_daily: number;
    search_page_daily: number;
    sync_runs: number;
  };
}

/**
 * Run (or, with dryRun, preview) the retention cleanup via the admin-guarded
 * run_cleanup() RPC. A dry run only counts the rows that would be removed.
 */
export async function runCleanup(dryRun: boolean): Promise<CleanupResult> {
  const { data, error } = await supabase.rpc("run_cleanup", {
    p_dry_run: dryRun,
  });
  if (error) throw error;
  return data as unknown as CleanupResult;
}

// ---------------------------------------------------------------------------
// V2: tracked queries, uptime, decay, AI briefing
// ---------------------------------------------------------------------------

export class PortfolioActionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "PortfolioActionError";
  }
}

/** Invoke an Edge Function and unwrap its sanitized error payload. */
async function invokeFunction<T>(
  name: string,
  body: Record<string, unknown>,
  fallbackMessage: string,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let status: number | undefined;
    let code = "error";
    let message = fallbackMessage;
    if (ctx && typeof ctx.json === "function") {
      status = ctx.status;
      try {
        const payload = (await ctx.clone().json()) as {
          error?: string;
          message?: string;
        };
        code = payload.error ?? code;
        message = payload.message ?? message;
      } catch {
        // non-JSON body - keep generic message
      }
    }
    throw new PortfolioActionError(code, message, status);
  }
  return data as T;
}

// Tracked queries -------------------------------------------------------------
export async function getTrackedQueries(
  siteId: string,
): Promise<TrackedQuery[]> {
  const { data, error } = await supabase
    .from("tracked_queries")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at");
  if (error) throw error;
  return data ?? [];
}

export async function addTrackedQuery(
  siteId: string,
  query: string,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    { action: "tracked-query.add", trackedQuery: { siteId, query } },
    "Could not track the query.",
  );
}

export async function removeTrackedQuery(
  siteId: string,
  query: string,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    { action: "tracked-query.remove", trackedQuery: { siteId, query } },
    "Could not untrack the query.",
  );
}

/** Daily history (from search_query_daily) for a site's tracked queries. */
export async function getTrackedQueryHistory(
  siteId: string,
  days: number,
): Promise<{ tracked: TrackedQuery[]; history: SearchQueryDaily[] }> {
  const tracked = await getTrackedQueries(siteId);
  if (tracked.length === 0) return { tracked, history: [] };
  const since = format(subDays(new Date(), days), "yyyy-MM-dd");
  const history = await fetchAllPages<SearchQueryDaily>(() =>
    supabase
      .from("search_query_daily")
      .select("*")
      .eq("site_id", siteId)
      .eq("engine", "google")
      .in(
        "query",
        tracked.map((t) => t.query),
      )
      .gte("metric_date", since)
      .order("metric_date"),
  );
  return { tracked, history };
}

// Uptime ----------------------------------------------------------------------
export interface UptimeSummary {
  siteId: string;
  checks: number;
  upPct: number | null;
  lastCheckAt: string | null;
  lastOk: boolean | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  recent: UptimeCheck[]; // newest first, bounded
}

/** Per-site uptime over the last 7 days, newest check first. */
export async function getUptimeSummaries(): Promise<
  Map<string, UptimeSummary>
> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await fetchAllPages<UptimeCheck>(() =>
    supabase
      .from("uptime_checks")
      .select("*")
      .gte("checked_at", since)
      .order("checked_at", { ascending: false }),
  );

  const map = new Map<string, UptimeSummary>();
  for (const row of rows) {
    let summary = map.get(row.site_id);
    if (!summary) {
      summary = {
        siteId: row.site_id,
        checks: 0,
        upPct: null,
        lastCheckAt: row.checked_at,
        lastOk: row.ok,
        lastStatusCode: row.status_code,
        lastLatencyMs: row.latency_ms,
        recent: [],
      };
      map.set(row.site_id, summary);
    }
    summary.checks += 1;
    if (summary.recent.length < 48) summary.recent.push(row);
  }
  for (const summary of map.values()) {
    const up = summary.recent.length
      ? rows.filter((r) => r.site_id === summary.siteId && r.ok).length
      : 0;
    summary.upPct = summary.checks > 0 ? (up / summary.checks) * 100 : null;
  }
  return map;
}

// Decaying content ------------------------------------------------------------
/** Raw per-page daily rows for the decay computation (2× window). */
export async function getSitePageDaily(
  siteId: string,
  days: number,
): Promise<SearchPageDaily[]> {
  const since = format(subDays(new Date(), days * 2), "yyyy-MM-dd");
  return fetchAllPages<SearchPageDaily>(() =>
    supabase
      .from("search_page_daily")
      .select("*")
      .eq("site_id", siteId)
      .eq("engine", "google")
      .gte("metric_date", since)
      .order("metric_date"),
  );
}

/** Page rows for every site (portfolio refresh queue). */
export async function getPortfolioPageDaily(
  days: number,
): Promise<SearchPageDaily[]> {
  const since = format(subDays(new Date(), days * 2), "yyyy-MM-dd");
  return fetchAllPages<SearchPageDaily>(() =>
    supabase
      .from("search_page_daily")
      .select("*")
      .eq("engine", "google")
      .gte("metric_date", since)
      .order("metric_date"),
  );
}

// AI briefing -----------------------------------------------------------------
export interface AiBriefingResult {
  configured: boolean;
  briefing: string | null;
  model: string | null;
}

export async function getAiBriefing(
  days: number,
  summary: Record<string, unknown>,
): Promise<AiBriefingResult> {
  const result = await invokeFunction<{
    ok: boolean;
    error?: string;
    briefing?: string;
    model?: string;
  }>("ai-briefing", { days, summary }, "Could not generate the briefing.");
  if (!result.ok && result.error === "not_configured") {
    return { configured: false, briefing: null, model: null };
  }
  if (!result.ok || !result.briefing) {
    throw new PortfolioActionError(
      result.error ?? "error",
      "Could not generate the briefing.",
    );
  }
  return {
    configured: true,
    briefing: result.briefing,
    model: result.model ?? null,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: tracked rank keywords, rank history, competitors, Common Crawl
// ---------------------------------------------------------------------------

export interface TrackedRankKeywordFormValues {
  siteId: string;
  query: string;
  engine: SearchEngine;
  device: RankDevice;
  country: string | null;
  location: string | null;
}

export async function getTrackedRankKeywords(
  siteId: string,
): Promise<TrackedRankKeyword[]> {
  const { data, error } = await supabase
    .from("tracked_rank_keywords")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at");
  if (error) throw error;
  return data ?? [];
}

export async function addTrackedRankKeyword(
  values: TrackedRankKeywordFormValues,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    {
      action: "rank-keyword.add",
      trackedRankKeyword: {
        siteId: values.siteId,
        query: values.query,
        engine: values.engine,
        device: values.device,
        country: values.country,
        location: values.location,
      },
    },
    "Could not save the tracked keyword.",
  );
}

export async function removeTrackedRankKeyword(id: string): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    { action: "rank-keyword.remove", trackedRankKeyword: { id } },
    "Could not remove the tracked keyword.",
  );
}

/** Full observation history for every rank keyword tracked on a site - the
 * caller (lib/rank-tracking.ts) matches rows back to keywords by dimension,
 * so this always returns the complete history, never just the latest. */
export async function getRankSnapshots(
  siteId: string,
): Promise<RankSnapshot[]> {
  return fetchAllPages<RankSnapshot>(() =>
    supabase
      .from("rank_snapshots")
      .select("*")
      .eq("site_id", siteId)
      .order("checked_at"),
  );
}

export interface RankObservationInput {
  trackedRankKeywordId: string;
  rankingUrl: string | null;
  observedRank: number | null;
}

/** A single manual rank check for one tracked keyword - always inserts a new
 * row, never updates or overwrites a prior observation. */
export async function recordRankObservation(
  input: RankObservationInput,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    { action: "rank-observation.record", observation: input },
    "Could not record the observation.",
  );
}

export interface SerpObservationResultInput {
  domain: string;
  url: string | null;
  rankObserved: number | null;
  isOwnSite: boolean;
}

/** A full observed-SERP entry (every domain seen for one query, not just our
 * own) - the zero-cost source for both our own observed rank and the
 * Observed Keyword Gap competitor data. */
export async function recordSerpObservation(
  trackedRankKeywordId: string,
  results: SerpObservationResultInput[],
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    {
      action: "serp-observation.record",
      observation: { trackedRankKeywordId, results },
    },
    "Could not record the SERP observation.",
  );
}

/** Raw per-engine query rows for the average-position cross-reference in
 * lib/rank-tracking.ts (computeEngineAveragePositions) - kept separate from
 * getKeywordOpportunities, which only exposes Google's own position. */
export async function getEngineQueryPositions(
  siteId: string,
  days: number,
): Promise<
  {
    engine: SearchEngine;
    query: string;
    impressions: number;
    average_position: number | null;
  }[]
> {
  const since = format(subDays(new Date(), days), "yyyy-MM-dd");
  return fetchAllPages(() =>
    supabase
      .from("search_query_daily")
      .select("engine, query, impressions, average_position")
      .eq("site_id", siteId)
      .gte("metric_date", since)
      .order("metric_date"),
  );
}

// Competitors -------------------------------------------------------------
export async function getCompetitorDomains(
  siteId: string,
): Promise<CompetitorDomain[]> {
  const { data, error } = await supabase
    .from("competitor_domains")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at");
  if (error) throw error;
  return data ?? [];
}

export interface CompetitorDomainFormValues {
  siteId: string;
  domain: string;
  label: string | null;
  note: string | null;
  autoDiscovered?: boolean;
}

export async function addCompetitorDomain(
  values: CompetitorDomainFormValues,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    {
      action: "competitor-domain.add",
      competitorDomain: {
        siteId: values.siteId,
        domain: values.domain,
        label: values.label,
        note: values.note,
        autoDiscovered: values.autoDiscovered ?? false,
      },
    },
    "Could not save the competitor domain.",
  );
}

export async function removeCompetitorDomain(
  siteId: string,
  domain: string,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    {
      action: "competitor-domain.remove",
      competitorDomain: { siteId, domain },
    },
    "Could not remove the competitor domain.",
  );
}

/** Every SERP observation recorded for a site - the raw material for
 * competitor appearance counts, shared/competitor-only keywords, and the
 * Observed Keyword Gap (all computed client-side in lib/competitor-insights.ts). */
export async function getObservedSerpResults(
  siteId: string,
): Promise<ObservedSerpResult[]> {
  return fetchAllPages<ObservedSerpResult>(() =>
    supabase
      .from("observed_serp_results")
      .select("*")
      .eq("site_id", siteId)
      .order("observed_at"),
  );
}

// Common Crawl --------------------------------------------------------------
export async function getCommonCrawlPages(
  domain: string,
): Promise<CommonCrawlPage[]> {
  return fetchAllPages<CommonCrawlPage>(() =>
    supabase
      .from("common_crawl_pages")
      .select("*")
      .eq("domain", domain)
      .order("last_seen", { ascending: false }),
  );
}

export async function getCommonCrawlRuns(
  domain: string,
): Promise<CommonCrawlRun[]> {
  const { data, error } = await supabase
    .from("common_crawl_runs")
    .select("*")
    .eq("domain", domain)
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}

export interface CommonCrawlSyncResult {
  ok: boolean;
  domain: string;
  crawlId: string;
  pagesFound: number;
  pagesNew: number;
  pagesDisappeared: number;
  titlesChecked: number;
}

/** On-demand only - never scheduled. See supabase/functions/common-crawl-sync. */
export async function triggerCommonCrawlSync(
  domain: string,
): Promise<CommonCrawlSyncResult> {
  return invokeFunction<CommonCrawlSyncResult>(
    "common-crawl-sync",
    { domain },
    "Could not sync Common Crawl data for this domain.",
  );
}

// ---------------------------------------------------------------------------
// Site Audit (CLAUDE.md Phase 5)
// ---------------------------------------------------------------------------

export async function getSiteAuditRuns(
  siteId: string,
): Promise<SiteAuditRun[]> {
  const { data, error } = await supabase
    .from("site_audit_runs")
    .select("*")
    .eq("site_id", siteId)
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}

export async function getSiteAuditIssues(
  runId: string,
): Promise<SiteAuditIssue[]> {
  return fetchAllPages<SiteAuditIssue>(() =>
    supabase
      .from("site_audit_issues")
      .select("*")
      .eq("run_id", runId)
      .order("severity"),
  );
}

export async function getSiteAuditPages(
  runId: string,
): Promise<SiteAuditPage[]> {
  return fetchAllPages<SiteAuditPage>(() =>
    supabase
      .from("site_audit_pages")
      .select("*")
      .eq("run_id", runId)
      .order("url"),
  );
}

export interface SiteAuditResult {
  ok: boolean;
  runId: string;
  pagesCrawled: number;
  healthScore: number;
  errorsCount: number;
  warningsCount: number;
  noticesCount: number;
}

/** On-demand only - never scheduled. See supabase/functions/site-audit-crawl. */
export async function triggerSiteAudit(
  siteId: string,
): Promise<SiteAuditResult> {
  return invokeFunction<SiteAuditResult>(
    "site-audit-crawl",
    { siteId },
    "Could not run the site audit.",
  );
}

// ---------------------------------------------------------------------------
// AI Visibility (CLAUDE.md Phase 8 / "AI Search source coverage")
// ---------------------------------------------------------------------------

/** GSC's search-appearance breakdown - the one platform in the AI Search
 * source coverage list with any webmaster-exposed data (see
 * lib/ai-search-sources.ts). Google hasn't published a fixed enum for AI
 * features, so every value GSC returns is fetched verbatim. */
export async function getSearchAppearanceDaily(
  siteId: string,
  days: number,
): Promise<SearchAppearanceDaily[]> {
  const since = format(subDays(new Date(), days * 2), "yyyy-MM-dd");
  return fetchAllPages<SearchAppearanceDaily>(() =>
    supabase
      .from("search_appearance_daily")
      .select("*")
      .eq("site_id", siteId)
      .eq("engine", "google")
      .gte("metric_date", since)
      .order("metric_date"),
  );
}

export async function getAiVisibilityPrompts(
  siteId: string,
): Promise<AiVisibilityPrompt[]> {
  const { data, error } = await supabase
    .from("ai_visibility_prompts")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at");
  if (error) throw error;
  return data ?? [];
}

export interface AiPromptFormValues {
  siteId: string;
  promptText: string;
  category: "observed" | "generated";
  sourceQuery: string | null;
}

export async function addAiVisibilityPrompt(
  values: AiPromptFormValues,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    {
      action: "ai-prompt.add",
      prompt: {
        siteId: values.siteId,
        promptText: values.promptText,
        category: values.category,
        sourceQuery: values.sourceQuery,
      },
    },
    "Could not save the prompt.",
  );
}

export async function removeAiVisibilityPrompt(id: string): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    { action: "ai-prompt.remove", prompt: { id } },
    "Could not remove the prompt.",
  );
}

export async function getAiVisibilityObservations(
  siteId: string,
): Promise<AiVisibilityObservation[]> {
  return fetchAllPages<AiVisibilityObservation>(() =>
    supabase
      .from("ai_visibility_observations")
      .select("*")
      .eq("site_id", siteId)
      .order("observed_at"),
  );
}

export interface AiObservationInput {
  siteId: string;
  promptId: string | null;
  promptText: string;
  source: AiVisibilitySource;
  isCited: boolean | null;
  citedUrl: string | null;
  competitorDomain: string | null;
  country: string | null;
  device: "desktop" | "mobile" | null;
  notes: string | null;
}

/** Always inserts a new row - a manual test result is never overwritten. */
export async function recordAiVisibilityObservation(
  input: AiObservationInput,
): Promise<void> {
  await invokeFunction(
    "manage-portfolio",
    { action: "ai-observation.record", observation: input },
    "Could not record the observation.",
  );
}

// ---------------------------------------------------------------------------
// Indexing / URL Inspection (Ranking Growth Roadmap Phase 4)
// ---------------------------------------------------------------------------

/** Imported Search Console coverage totals, ordered chronologically so the
 * dashboard can reliably select the latest snapshot. */
export async function getGscCoverageSnapshots(
  siteId: string,
): Promise<GscCoverageSnapshot[]> {
  return fetchAllPages<GscCoverageSnapshot>(() =>
    supabase
      .from("gsc_coverage_snapshots")
      .select("*")
      .eq("site_id", siteId)
      .order("metric_date")
      .order("imported_at"),
  );
}

/** The current cached state for every URL this site has ever had inspected -
 * cheap to read for the Indexing dashboard (see supabase/functions/
 * inspect-urls and scheduled-inspect-urls for how rows get here). */
export async function getUrlInspections(
  siteId: string,
): Promise<UrlInspection[]> {
  return fetchAllPages<UrlInspection>(() =>
    supabase
      .from("url_inspections")
      .select("*")
      .eq("site_id", siteId)
      .order("last_inspected_at", { ascending: false }),
  );
}

/** Snapshot history for one URL, newest first - lets the UI show real
 * changes over time ("Not indexed -> Indexed" etc.) without ever
 * overwriting the only previous state. Fetched on demand (row expand), not
 * for every tracked URL up front. */
export async function getUrlInspectionHistory(
  siteId: string,
  url: string,
): Promise<UrlInspectionHistory[]> {
  const { data, error } = await supabase
    .from("url_inspection_history")
    .select("*")
    .eq("site_id", siteId)
    .eq("url", url)
    .order("inspected_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}

export interface InspectUrlsResult {
  ok: boolean;
  results: Array<{
    url: string;
    status: "inspected" | "skipped_cached" | "failed";
    ninjaStatus?: string;
    errorMessage?: string;
  }>;
  inspected: number;
  skippedCached: number;
  failed: number;
}

/** On-demand only. See supabase/functions/inspect-urls - a hard server-side
 * cap (10/request) enforces the Search Console quota regardless of how many
 * URLs the caller passes. Already-fresh URLs are skipped (not re-inspected)
 * unless `force` is set, so re-clicking "Inspect" on an unchanged URL never
 * spends quota for nothing. */
export async function triggerUrlInspection(
  siteId: string,
  urls: string[],
  opts: {
    force?: boolean;
    siteLastmodByUrl?: Record<string, string | null>;
  } = {},
): Promise<InspectUrlsResult> {
  return invokeFunction<InspectUrlsResult>(
    "inspect-urls",
    {
      siteId,
      urls,
      force: opts.force ?? false,
      siteLastmodByUrl: opts.siteLastmodByUrl,
    },
    "Could not inspect these URLs.",
  );
}
