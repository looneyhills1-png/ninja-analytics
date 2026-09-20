-- 0014_keyword_intelligence.sql
-- Phase 1 (Keyword Intelligence / Opportunity Engine) plus schema-only
-- groundwork for Phase 2 (real rank tracking) and Phase 4 (observed
-- competitor/keyword-gap data). See CLAUDE.md for the phase plan.
--
-- Access model is identical to the rest of the schema (0002_rls.sql /
-- 0006_search_breakdowns.sql):
--   * Browser reads: portfolio admin on an MFA-verified (aal2) session.
--   * Browser writes: none. All writes happen server-side via Edge
--     Functions / future scheduled jobs using privileged (service_role)
--     credentials.

-- ---------------------------------------------------------------------------
-- search_query_page_daily: the GSC [date, query, page] combined breakdown.
-- This is the ONLY reliable, exact source for "which URL actually ranks for
-- this query" - search_query_daily and search_page_daily are each queried
-- against GSC as separate single-dimension breakdowns, so neither one alone
-- can answer that question without guessing. Populated by extending the
-- existing gscAdapter sync (see supabase/functions/_shared/gsc.ts) with a
-- third best-effort breakdown fetch - not a new integration, not a new
-- provider, same GSC Search Analytics API the site already calls.
-- ---------------------------------------------------------------------------
create table public.search_query_page_daily (
  site_id uuid not null references public.sites (id) on delete cascade,
  engine text not null check (engine in ('google', 'bing')),
  metric_date date not null,
  query text not null,
  page text not null,

  clicks bigint not null default 0,
  impressions bigint not null default 0,
  ctr numeric,
  average_position numeric,

  updated_at timestamptz not null default now(),

  primary key (site_id, engine, metric_date, query, page)
);

create index search_query_page_daily_site_date_idx
  on public.search_query_page_daily (site_id, metric_date desc);
create index search_query_page_daily_query_idx
  on public.search_query_page_daily (site_id, engine, query);

alter table public.search_query_page_daily enable row level security;

create policy "search_query_page_daily admin select"
  on public.search_query_page_daily as permissive for select to authenticated
  using (public.is_portfolio_admin());
create policy "search_query_page_daily require aal2"
  on public.search_query_page_daily as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.search_query_page_daily to authenticated;
revoke all on public.search_query_page_daily from anon;
grant select, insert, update, delete on public.search_query_page_daily
  to service_role;

-- ---------------------------------------------------------------------------
-- Phase 2 groundwork: real observed rank history, distinct from GSC's own
-- average_position (which is a Google-computed average across many query
-- variants/auctions, not a single observed SERP position - see brief §Phase2
-- and CLAUDE.md "Keep GSC average position and observed rank as separate
-- metrics"). Empty until a rank-tracking worker exists; no paid rank API is
-- introduced by this migration. Deliberately generic across search engine/
-- device/location so a future free-and-permitted observation method (or a
-- manual spot-check) can write into the same shape GSC-derived estimates
-- never touch.
-- ---------------------------------------------------------------------------
create table public.rank_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,

  query text not null check (char_length(query) between 1 and 200),
  engine text not null default 'google' check (engine in ('google', 'bing')),
  device text not null default 'desktop' check (device in ('desktop', 'mobile')),
  country text,
  location text,

  ranking_url text,
  observed_rank integer check (observed_rank is null or observed_rank > 0),

  -- How this row was produced - never blended with GSC average_position
  -- without this label carried through to the UI.
  source text not null default 'manual'
    check (source in ('manual', 'observed_serp')),

  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index rank_snapshots_site_query_idx
  on public.rank_snapshots (site_id, query, engine, device, checked_at desc);

alter table public.rank_snapshots enable row level security;

create policy "rank_snapshots admin select"
  on public.rank_snapshots as permissive for select to authenticated
  using (public.is_portfolio_admin());
create policy "rank_snapshots require aal2"
  on public.rank_snapshots as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.rank_snapshots to authenticated;
revoke all on public.rank_snapshots from anon;
grant select, insert, update, delete on public.rank_snapshots to service_role;

-- ---------------------------------------------------------------------------
-- Phase 4 groundwork: "Observed Keyword Gap", built bottom-up from our own
-- tracked SERPs - never a claim to a Google-wide keyword database.
--   competitor_domains: an admin-managed allow-list of domains to watch
--     (manual entries are useful immediately; auto-discovery from
--     observed_serp_results comes later, hence discovered_from_site_id).
--   observed_serp_results: one row per domain seen in a SERP we actually
--     looked at for a tracked query - empty until a Phase 4 SERP-observation
--     worker exists. No paid SERP API is introduced by this migration.
-- ---------------------------------------------------------------------------
create table public.competitor_domains (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,

  domain text not null check (char_length(domain) between 1 and 253),
  label text,
  note text check (note is null or char_length(note) <= 300),

  -- true once auto-discovered from repeatedly appearing in
  -- observed_serp_results; manual entries stay false.
  auto_discovered boolean not null default false,

  created_at timestamptz not null default now(),

  unique (site_id, domain)
);

alter table public.competitor_domains enable row level security;

create policy "competitor_domains admin select"
  on public.competitor_domains as permissive for select to authenticated
  using (public.is_portfolio_admin());
create policy "competitor_domains require aal2"
  on public.competitor_domains as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.competitor_domains to authenticated;
revoke all on public.competitor_domains from anon;
grant select, insert, update, delete on public.competitor_domains
  to service_role;

create table public.observed_serp_results (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,

  query text not null check (char_length(query) between 1 and 200),
  engine text not null default 'google' check (engine in ('google', 'bing')),
  observed_at timestamptz not null default now(),

  domain text not null,
  url text,
  rank_observed integer check (rank_observed is null or rank_observed > 0),
  is_own_site boolean not null default false,

  created_at timestamptz not null default now()
);

create index observed_serp_results_site_query_idx
  on public.observed_serp_results (site_id, query, engine, observed_at desc);
create index observed_serp_results_domain_idx
  on public.observed_serp_results (site_id, domain);

alter table public.observed_serp_results enable row level security;

create policy "observed_serp_results admin select"
  on public.observed_serp_results as permissive for select to authenticated
  using (public.is_portfolio_admin());
create policy "observed_serp_results require aal2"
  on public.observed_serp_results as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.observed_serp_results to authenticated;
revoke all on public.observed_serp_results from anon;
grant select, insert, update, delete on public.observed_serp_results
  to service_role;

-- ---------------------------------------------------------------------------
-- Extend retention (0008_data_retention.sql) to cover the new tables.
-- search_query_page_daily is high volume (query x page combinations, not
-- just query or page alone) so it gets the same 210-day window as
-- search_query_daily/search_page_daily. rank_snapshots and
-- observed_serp_results start empty in Phase 1 but get a sane window now
-- (365 days) so nobody has to remember to add retention once Phase 2/4
-- workers start writing to them.
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
  v_now        timestamptz := now();
  v_daily_cut  date        := (v_now - make_interval(days => v_daily_days))::date;
  v_terms_cut  date        := (v_now - make_interval(days => v_terms_days))::date;
  v_runs_cut   timestamptz := v_now - make_interval(days => v_runs_days);
  v_rank_cut   timestamptz := v_now - make_interval(days => v_rank_days);
  v_analytics  bigint;
  v_search     bigint;
  v_query      bigint;
  v_page       bigint;
  v_query_page bigint;
  v_runs       bigint;
  v_rank       bigint;
  v_serp       bigint;
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
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'executed_at', v_now,
    'cutoffs', jsonb_build_object(
      'daily', v_daily_cut,
      'search_terms', v_terms_cut,
      'sync_runs', v_runs_cut,
      'rank_history', v_rank_cut
    ),
    'deleted', jsonb_build_object(
      'analytics_daily', v_analytics,
      'search_daily', v_search,
      'search_query_daily', v_query,
      'search_page_daily', v_page,
      'search_query_page_daily', v_query_page,
      'sync_runs', v_runs,
      'rank_snapshots', v_rank,
      'observed_serp_results', v_serp
    )
  );
end;
$$;

revoke all on function public.prune_portfolio_data(boolean) from public;
revoke all on function public.prune_portfolio_data(boolean) from anon, authenticated;
