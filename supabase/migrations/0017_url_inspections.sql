-- 0017_url_inspections.sql
-- Ranking Growth Roadmap Phase 4: Google URL Inspection / Indexing Tracker.
-- Uses the official Search Console URL Inspection API
-- (searchconsole.urlInspection.index.inspect) via the same Google OAuth
-- credentials the existing GSC sync already uses (_shared/google-auth.ts) -
-- no new secret, no misuse of the separate (crawler-only) Indexing API.
--
-- Two tables, same shape as the Site Audit pattern (0015/0016):
--   url_inspections       - the CURRENT/latest cached state per (site, url).
--     Upserted every time a URL is (re-)inspected, cheap to read for the
--     Indexing dashboard's summary cards and table.
--   url_inspection_history - an append-only snapshot per inspection, so
--     Ninja can show real changes over time ("Not indexed -> Indexed",
--     "Google canonical changed", "Blocked -> Allowed") without ever
--     overwriting the only previous state - the whole point of a history
--     table instead of just the cache row.
--
-- Access model identical to the rest of the schema (0002_rls.sql / the
-- site_audit_* tables): admin-only select, aal2 required, service_role
-- does the writes from the edge functions. Written idempotently per
-- deploy-ninja-analytics.yml's fallback (create/alter ... if not exists,
-- drop-then-create policies).

create table if not exists public.url_inspections (
  site_id uuid not null references public.sites (id) on delete cascade,
  url text not null check (char_length(url) between 1 and 2000),

  last_inspected_at timestamptz not null default now(),
  inspected_by uuid, -- auth.users id for a manual inspection, null for scheduled

  -- Google's own verbatim fields (never re-labelled as more certain than
  -- Google states them) - see _shared/gsc-url-inspection.ts for the exact
  -- API response fields these map to.
  verdict text, -- Google's top-level verdict: PASS/NEUTRAL/FAIL/PARTIAL/VERDICT_UNSPECIFIED
  coverage_state text, -- e.g. "Submitted and indexed", "Crawled - currently not indexed"
  robots_txt_state text, -- ALLOWED/DISALLOWED/ROBOTS_TXT_STATE_UNSPECIFIED
  indexing_state text, -- INDEXING_ALLOWED/BLOCKED_BY_META_TAG/... (Google's indexingState)
  page_fetch_state text, -- SUCCESSFUL/SOFT_404/NOT_FOUND/ACCESS_DENIED/...
  google_canonical text, -- Google's chosen canonical (googleCanonical)
  user_canonical text, -- the page's own declared canonical (userCanonical)
  last_crawl_time timestamptz, -- Google's lastCrawlTime, null if never crawled
  crawled_as text, -- MOBILE/DESKTOP/CRAWLING_USER_AGENT_UNSPECIFIED
  sitemaps text[] not null default '{}', -- sitemap(s) Google says reference this URL

  -- Ninja's own transparent bucket, derived from the verbatim fields above
  -- at write time (see gsc-url-inspection.ts's classifyIndexStatus) - never
  -- a separate guess, always a documented function of Google's own data.
  ninja_status text not null check (ninja_status in (
    'indexed', 'not_indexed', 'crawled_not_indexed', 'discovered_not_indexed',
    'canonical_mismatch', 'blocked', 'unknown'
  )),

  -- The site's own last-modified signal for this URL at inspection time
  -- (from src/data's sitemap.xml <lastmod>, fetched client-side - see
  -- src/features/indexing/sitemap-lastmod.ts), so "changed materially after
  -- Google's last crawl" can be computed honestly (site lastmod newer than
  -- last_crawl_time) instead of invented. Null if the sitemap has no
  -- lastmod for this URL.
  site_lastmod date,

  raw_response jsonb, -- full API response, for completeness/debugging only

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (site_id, url)
);

create index if not exists url_inspections_site_status_idx
  on public.url_inspections (site_id, ninja_status);
create index if not exists url_inspections_site_inspected_idx
  on public.url_inspections (site_id, last_inspected_at);

create table if not exists public.url_inspection_history (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  url text not null check (char_length(url) between 1 and 2000),

  inspected_at timestamptz not null default now(),
  inspected_by uuid,

  verdict text,
  coverage_state text,
  robots_txt_state text,
  indexing_state text,
  page_fetch_state text,
  google_canonical text,
  user_canonical text,
  last_crawl_time timestamptz,
  crawled_as text,
  sitemaps text[] not null default '{}',
  ninja_status text not null check (ninja_status in (
    'indexed', 'not_indexed', 'crawled_not_indexed', 'discovered_not_indexed',
    'canonical_mismatch', 'blocked', 'unknown'
  )),
  site_lastmod date
);

create index if not exists url_inspection_history_site_url_idx
  on public.url_inspection_history (site_id, url, inspected_at desc);

alter table public.url_inspections enable row level security;
alter table public.url_inspection_history enable row level security;

drop policy if exists "url_inspections admin select" on public.url_inspections;
create policy "url_inspections admin select"
  on public.url_inspections as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "url_inspections require aal2" on public.url_inspections;
create policy "url_inspections require aal2"
  on public.url_inspections as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "url_inspection_history admin select"
  on public.url_inspection_history;
create policy "url_inspection_history admin select"
  on public.url_inspection_history as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "url_inspection_history require aal2"
  on public.url_inspection_history;
create policy "url_inspection_history require aal2"
  on public.url_inspection_history as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.url_inspections, public.url_inspection_history
  to authenticated;
revoke all on public.url_inspections, public.url_inspection_history from anon;
grant select, insert, update, delete
  on public.url_inspections, public.url_inspection_history
  to service_role;

-- ---------------------------------------------------------------------------
-- Scheduled batch inspection: a small, quota-respecting daily re-check of
-- already-tracked URLs (the most stale ones first), same invoke pattern as
-- 0005_cron_jobs.sql's invoke_scheduled_sync - Vault holds the URL/secret,
-- never this migration. New URLs are added to the tracker via the
-- manual/on-demand "Inspect" action in the UI (CLAUDE.md: "no high-frequency
-- GitHub Actions... use Supabase/Edge Functions... controlled scheduled
-- batches" - this is the batch, the UI drives what's worth tracking).
-- ---------------------------------------------------------------------------
create or replace function public.invoke_scheduled_url_inspection()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'automation_secret';

  if v_url is null or v_secret is null then
    raise exception 'Missing Vault secret project_url or automation_secret';
  end if;

  perform net.http_post(
    url := v_url || '/functions/v1/scheduled-inspect-urls',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Automation-Secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function public.invoke_scheduled_url_inspection() from public;
revoke all on function public.invoke_scheduled_url_inspection()
  from anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'site-analytics-url-inspection') then
    perform cron.unschedule('site-analytics-url-inspection');
  end if;
end;
$$;

-- Once daily, off the top of the existing 04:00 UTC sync window so it never
-- competes with the gsc/ga4/bing syncs for Search Console quota headroom.
select cron.schedule(
  'site-analytics-url-inspection', '30 4 * * *',
  $$select public.invoke_scheduled_url_inspection()$$
);

-- ---------------------------------------------------------------------------
-- Retention: history follows the same 180-day audit window as
-- site_audit_runs/common_crawl_runs - it's a comparable append-only
-- inspection log, not something that needs indefinite retention. The
-- current-state cache (url_inspections) is never pruned by date - it always
-- holds one row per tracked URL, replaced on the next inspection.
-- ---------------------------------------------------------------------------
create or replace function public.prune_portfolio_data(p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_daily_days int := 540;
  v_terms_days int := 210;
  v_runs_days  int := 120;
  v_rank_days  int := 365;
  v_audit_days int := 180;
  v_now        timestamptz := now();
  v_daily_cut  date        := (v_now - make_interval(days => v_daily_days))::date;
  v_terms_cut  date        := (v_now - make_interval(days => v_terms_days))::date;
  v_runs_cut   timestamptz := v_now - make_interval(days => v_runs_days);
  v_rank_cut   timestamptz := v_now - make_interval(days => v_rank_days);
  v_audit_cut  timestamptz := v_now - make_interval(days => v_audit_days);
  v_analytics  bigint;
  v_search     bigint;
  v_query      bigint;
  v_page       bigint;
  v_query_page bigint;
  v_appearance bigint;
  v_runs       bigint;
  v_rank       bigint;
  v_serp       bigint;
  v_audit_runs bigint;
  v_cc_runs    bigint;
  v_ai_obs     bigint;
  v_inspect_history bigint;
begin
  if p_dry_run then
    select count(*) into v_analytics
      from public.analytics_daily where metric_date < v_daily_cut;
    select count(*) into v_search
      from public.search_daily where metric_date < v_daily_cut;
    select count(*) into v_query
      from public.search_query_daily where metric_date < v_terms_cut;
    select count(*) into v_page
      from public.search_page_daily where metric_date < v_terms_cut;
    select count(*) into v_query_page
      from public.search_query_page_daily where metric_date < v_terms_cut;
    select count(*) into v_appearance
      from public.search_appearance_daily where metric_date < v_terms_cut;
    select count(*) into v_runs
      from public.sync_runs
      where started_at < v_runs_cut and status <> 'running';
    select count(*) into v_rank
      from public.rank_snapshots where checked_at < v_rank_cut;
    select count(*) into v_serp
      from public.observed_serp_results where observed_at < v_rank_cut;
    select count(*) into v_audit_runs
      from public.site_audit_runs
      where started_at < v_audit_cut and status <> 'running';
    select count(*) into v_cc_runs
      from public.common_crawl_runs
      where started_at < v_audit_cut and status <> 'running';
    select count(*) into v_ai_obs
      from public.ai_visibility_observations where observed_at < v_rank_cut;
    select count(*) into v_inspect_history
      from public.url_inspection_history where inspected_at < v_audit_cut;
  else
    delete from public.analytics_daily where metric_date < v_daily_cut;
    get diagnostics v_analytics = row_count;
    delete from public.search_daily where metric_date < v_daily_cut;
    get diagnostics v_search = row_count;
    delete from public.search_query_daily where metric_date < v_terms_cut;
    get diagnostics v_query = row_count;
    delete from public.search_page_daily where metric_date < v_terms_cut;
    get diagnostics v_page = row_count;
    delete from public.search_query_page_daily where metric_date < v_terms_cut;
    get diagnostics v_query_page = row_count;
    delete from public.search_appearance_daily where metric_date < v_terms_cut;
    get diagnostics v_appearance = row_count;
    delete from public.sync_runs
      where started_at < v_runs_cut and status <> 'running';
    get diagnostics v_runs = row_count;
    delete from public.rank_snapshots where checked_at < v_rank_cut;
    get diagnostics v_rank = row_count;
    delete from public.observed_serp_results where observed_at < v_rank_cut;
    get diagnostics v_serp = row_count;
    -- site_audit_pages/site_audit_issues cascade with their run.
    delete from public.site_audit_runs
      where started_at < v_audit_cut and status <> 'running';
    get diagnostics v_audit_runs = row_count;
    delete from public.common_crawl_runs
      where started_at < v_audit_cut and status <> 'running';
    get diagnostics v_cc_runs = row_count;
    delete from public.ai_visibility_observations where observed_at < v_rank_cut;
    get diagnostics v_ai_obs = row_count;
    delete from public.url_inspection_history where inspected_at < v_audit_cut;
    get diagnostics v_inspect_history = row_count;
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'executed_at', v_now,
    'cutoffs', jsonb_build_object(
      'daily', v_daily_cut,
      'search_terms', v_terms_cut,
      'sync_runs', v_runs_cut,
      'rank_history', v_rank_cut,
      'audit_runs', v_audit_cut
    ),
    'deleted', jsonb_build_object(
      'analytics_daily', v_analytics,
      'search_daily', v_search,
      'search_query_daily', v_query,
      'search_page_daily', v_page,
      'search_query_page_daily', v_query_page,
      'search_appearance_daily', v_appearance,
      'sync_runs', v_runs,
      'rank_snapshots', v_rank,
      'observed_serp_results', v_serp,
      'site_audit_runs', v_audit_runs,
      'common_crawl_runs', v_cc_runs,
      'ai_visibility_observations', v_ai_obs,
      'url_inspection_history', v_inspect_history
    )
  );
end;
$$;

revoke all on function public.prune_portfolio_data(boolean) from public;
revoke all on function public.prune_portfolio_data(boolean) from anon, authenticated;
