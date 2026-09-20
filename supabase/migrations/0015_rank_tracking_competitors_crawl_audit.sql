-- 0015_rank_tracking_competitors_crawl_audit.sql
-- Phase 2: real tracked-keyword rank tracking, observed competitor
-- discovery, a zero-cost Common Crawl research module, and schema-only
-- groundwork for a later Site Audit crawler. See CLAUDE.md for the phase
-- plan and the zero-cost rule - nothing here calls or requires Semrush/
-- Ahrefs/DataForSEO/SerpApi/Moz/Majestic or any other paid SEO data
-- provider.
--
-- Access model is identical to the rest of the schema (0002_rls.sql):
--   * Browser reads: portfolio admin on an MFA-verified (aal2) session.
--   * Browser writes: none. All writes happen server-side via Edge
--     Functions using privileged (service_role) credentials.
--
-- Written idempotently (create table/index if not exists, drop-then-create
-- policies) per deploy-ninja-analytics.yml's fallback, which re-applies
-- every migration from 0011 onward on every deploy where `supabase db push`
-- can't run - every migration from here on must tolerate being executed
-- more than once.

-- ---------------------------------------------------------------------------
-- Tracked rank keywords: which (site, query, engine, device, country,
-- location) combinations to observe. Separate from tracked_queries (0009),
-- which is GSC-only and has no engine/device/location dimension - this table
-- is the config surface for the rank_snapshots history already created in
-- 0014. Generated *_key columns exist only so NULL country/location still
-- participate in the uniqueness check (plain NULLs are never equal to each
-- other in a standard unique constraint).
-- ---------------------------------------------------------------------------
create table if not exists public.tracked_rank_keywords (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,

  query text not null check (char_length(query) between 1 and 200),
  engine text not null default 'google' check (engine in ('google', 'bing')),
  device text not null default 'desktop' check (device in ('desktop', 'mobile')),
  country text check (country is null or char_length(country) <= 10),
  location text check (location is null or char_length(location) <= 120),

  country_key text generated always as (coalesce(country, '')) stored,
  location_key text generated always as (coalesce(location, '')) stored,

  created_at timestamptz not null default now(),

  unique (site_id, query, engine, device, country_key, location_key)
);

create index if not exists tracked_rank_keywords_site_idx
  on public.tracked_rank_keywords (site_id);

alter table public.tracked_rank_keywords enable row level security;

drop policy if exists "tracked_rank_keywords admin select"
  on public.tracked_rank_keywords;
create policy "tracked_rank_keywords admin select"
  on public.tracked_rank_keywords as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "tracked_rank_keywords require aal2"
  on public.tracked_rank_keywords;
create policy "tracked_rank_keywords require aal2"
  on public.tracked_rank_keywords as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.tracked_rank_keywords to authenticated;
revoke all on public.tracked_rank_keywords from anon;
grant select, insert, update, delete on public.tracked_rank_keywords
  to service_role;

-- ---------------------------------------------------------------------------
-- Common Crawl research module (zero-cost: index.commoncrawl.org's public
-- CDX API, no mirroring). Domain-scoped rather than site_id-scoped, because
-- the same competitor domain can be watched from more than one of our sites
-- without duplicating its page history, and our own tracked sites' domains
-- can use the same tables.
-- ---------------------------------------------------------------------------
create table if not exists public.common_crawl_runs (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (char_length(domain) between 1 and 253),
  crawl_id text,

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'success', 'failed')),

  pages_found integer not null default 0,
  pages_new integer not null default 0,
  pages_disappeared integer not null default 0,
  error_message text
);

create index if not exists common_crawl_runs_domain_idx
  on public.common_crawl_runs (domain, started_at desc);

create table if not exists public.common_crawl_pages (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (char_length(domain) between 1 and 253),
  url text not null check (char_length(url) between 1 and 2000),

  first_seen date not null,
  last_seen date not null,
  cdx_status_code integer,
  last_status_code integer,
  mime_type text,
  title text,
  is_active boolean not null default true,
  last_checked_at timestamptz not null default now(),

  unique (domain, url)
);

create index if not exists common_crawl_pages_domain_idx
  on public.common_crawl_pages (domain, is_active);

alter table public.common_crawl_runs enable row level security;
alter table public.common_crawl_pages enable row level security;

drop policy if exists "common_crawl_runs admin select" on public.common_crawl_runs;
create policy "common_crawl_runs admin select"
  on public.common_crawl_runs as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "common_crawl_runs require aal2" on public.common_crawl_runs;
create policy "common_crawl_runs require aal2"
  on public.common_crawl_runs as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "common_crawl_pages admin select" on public.common_crawl_pages;
create policy "common_crawl_pages admin select"
  on public.common_crawl_pages as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "common_crawl_pages require aal2" on public.common_crawl_pages;
create policy "common_crawl_pages require aal2"
  on public.common_crawl_pages as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.common_crawl_runs, public.common_crawl_pages
  to authenticated;
revoke all on public.common_crawl_runs, public.common_crawl_pages from anon;
grant select, insert, update, delete
  on public.common_crawl_runs, public.common_crawl_pages
  to service_role;

-- ---------------------------------------------------------------------------
-- Site Audit groundwork only (schema, no crawler yet - deferred to a later
-- phase). One run per crawl, with per-page findings and per-issue rows so
-- the UI can eventually show a Health Score plus filterable
-- Errors/Warnings/Notices without re-deriving them each time.
-- ---------------------------------------------------------------------------
create table if not exists public.site_audit_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'success', 'failed')),

  pages_crawled integer not null default 0,
  health_score integer check (health_score is null or health_score between 0 and 100),
  errors_count integer not null default 0,
  warnings_count integer not null default 0,
  notices_count integer not null default 0,
  error_message text
);

create index if not exists site_audit_runs_site_idx
  on public.site_audit_runs (site_id, started_at desc);

create table if not exists public.site_audit_pages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.site_audit_runs (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,

  url text not null check (char_length(url) between 1 and 2000),
  status_code integer,
  is_redirect boolean not null default false,
  redirect_target text,

  canonical_url text,
  is_self_canonical boolean,
  meta_robots_noindex boolean not null default false,

  title text,
  title_length integer,
  meta_description text,
  meta_description_length integer,
  h1_count integer,
  h2_count integer,
  word_count integer,

  internal_link_count integer,
  external_link_count integer,
  images_total integer,
  images_missing_alt integer,
  has_schema boolean not null default false,
  content_hash text,

  crawl_depth integer,
  in_sitemap boolean not null default false,
  discovered_from text check (discovered_from in ('crawl', 'sitemap'))
);

create index if not exists site_audit_pages_run_idx on public.site_audit_pages (run_id);
create index if not exists site_audit_pages_site_url_idx
  on public.site_audit_pages (site_id, url);
create index if not exists site_audit_pages_hash_idx
  on public.site_audit_pages (run_id, content_hash);

create table if not exists public.site_audit_issues (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.site_audit_runs (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,

  url text,
  severity text not null check (severity in ('error', 'warning', 'notice')),
  category text not null,
  code text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists site_audit_issues_run_idx
  on public.site_audit_issues (run_id, severity);

alter table public.site_audit_runs enable row level security;
alter table public.site_audit_pages enable row level security;
alter table public.site_audit_issues enable row level security;

drop policy if exists "site_audit_runs admin select" on public.site_audit_runs;
create policy "site_audit_runs admin select"
  on public.site_audit_runs as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "site_audit_runs require aal2" on public.site_audit_runs;
create policy "site_audit_runs require aal2"
  on public.site_audit_runs as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "site_audit_pages admin select" on public.site_audit_pages;
create policy "site_audit_pages admin select"
  on public.site_audit_pages as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "site_audit_pages require aal2" on public.site_audit_pages;
create policy "site_audit_pages require aal2"
  on public.site_audit_pages as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "site_audit_issues admin select" on public.site_audit_issues;
create policy "site_audit_issues admin select"
  on public.site_audit_issues as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "site_audit_issues require aal2" on public.site_audit_issues;
create policy "site_audit_issues require aal2"
  on public.site_audit_issues as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on
  public.site_audit_runs, public.site_audit_pages, public.site_audit_issues
  to authenticated;
revoke all on
  public.site_audit_runs, public.site_audit_pages, public.site_audit_issues
  from anon;
grant select, insert, update, delete on
  public.site_audit_runs, public.site_audit_pages, public.site_audit_issues
  to service_role;

-- ---------------------------------------------------------------------------
-- Extend retention (0008/0014) to cover the new time-series/log tables.
-- tracked_rank_keywords and competitor_domains are config, not logs - never
-- pruned, same treatment as tracked_queries. common_crawl_pages holds
-- current known state (deactivated in place via is_active, not deleted) so
-- it is not pruned here either. rank_snapshots/observed_serp_results were
-- already covered by 0014's 365-day window.
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
  v_runs       bigint;
  v_rank       bigint;
  v_serp       bigint;
  v_audit_runs bigint;
  v_cc_runs    bigint;
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
      'sync_runs', v_runs,
      'rank_snapshots', v_rank,
      'observed_serp_results', v_serp,
      'site_audit_runs', v_audit_runs,
      'common_crawl_runs', v_cc_runs
    )
  );
end;
$$;

revoke all on function public.prune_portfolio_data(boolean) from public;
revoke all on function public.prune_portfolio_data(boolean) from anon, authenticated;
