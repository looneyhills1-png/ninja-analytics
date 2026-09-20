-- 0016_site_audit_and_ai_visibility.sql
-- Phase 5 (Site Audit crawler - now implemented, not just schema) plus
-- Phase 8 / "AI Search source coverage" (CLAUDE.md): a GSC search-appearance
-- breakdown (Google's own webmaster data, where exposed) and a manual/
-- on-demand AI-visibility observation log covering every source CLAUDE.md
-- lists, since none of them expose a free per-site query/citation API.
--
-- Access model is identical to the rest of the schema (0002_rls.sql).
-- Written idempotently per deploy-ninja-analytics.yml's fallback (see its
-- header comment): create table/index if not exists, add column if not
-- exists, drop-then-create policies.

-- ---------------------------------------------------------------------------
-- Site Audit: a few page-level checks the 0015 schema didn't yet have
-- columns for (CLAUDE.md Phase 5: OpenGraph, hreflang, mobile viewport,
-- pagination, response timing).
-- ---------------------------------------------------------------------------
alter table public.site_audit_pages
  add column if not exists has_viewport_meta boolean not null default false,
  add column if not exists has_opengraph boolean not null default false,
  add column if not exists has_hreflang boolean not null default false,
  add column if not exists has_pagination boolean not null default false,
  add column if not exists response_time_ms integer;

-- ---------------------------------------------------------------------------
-- search_appearance_daily: a fourth best-effort GSC breakdown. This is the
-- "GSC Generative AI features data where exposed" data CLAUDE.md's Phase 8
-- calls for - Google has not published a fixed, stable enum of
-- searchAppearance values for AI features as of this writing, so the row
-- is stored verbatim (whatever value GSC returns) and the UI applies a
-- heuristic, clearly-labelled "looks AI-related" filter rather than
-- assuming a specific string.
--
-- Despite the table name, this is NOT dimensioned by [date, searchAppearance]
-- the way the other three breakdowns are - Google's Search Analytics API
-- rejects combining searchAppearance with any other dimension ("Cannot
-- group by search appearance dimension together with another dimension"),
-- so each sync queries searchAppearance alone and gets one row per
-- appearance type aggregated over the whole requested date range, not a
-- true per-day figure. metric_date is that range's end date, used only as
-- a chronological/upsert anchor (see _shared/gsc.ts) - each day's synced
-- row is a "trailing window as of today" snapshot, not a distinct daily
-- measurement the way search_query_daily/search_page_daily's rows are.
-- ---------------------------------------------------------------------------
create table if not exists public.search_appearance_daily (
  site_id uuid not null references public.sites (id) on delete cascade,
  engine text not null check (engine in ('google', 'bing')),
  metric_date date not null,
  search_appearance text not null,

  clicks bigint not null default 0,
  impressions bigint not null default 0,
  ctr numeric,
  average_position numeric,

  updated_at timestamptz not null default now(),

  primary key (site_id, engine, metric_date, search_appearance)
);

create index if not exists search_appearance_daily_site_date_idx
  on public.search_appearance_daily (site_id, metric_date desc);

alter table public.search_appearance_daily enable row level security;

drop policy if exists "search_appearance_daily admin select"
  on public.search_appearance_daily;
create policy "search_appearance_daily admin select"
  on public.search_appearance_daily as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "search_appearance_daily require aal2"
  on public.search_appearance_daily;
create policy "search_appearance_daily require aal2"
  on public.search_appearance_daily as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.search_appearance_daily to authenticated;
revoke all on public.search_appearance_daily from anon;
grant select, insert, update, delete on public.search_appearance_daily
  to service_role;

-- ---------------------------------------------------------------------------
-- AI Visibility: prompts to test (observed real queries, or generated
-- candidate opportunities - always labelled which) and the manual/on-demand
-- observation log across every AI/search system CLAUDE.md's "AI Search
-- source coverage" section names. None of ChatGPT/Gemini/Copilot/Claude/
-- Siri/Alexa/Yahoo/DuckDuckGo/Brave/Ecosia/Dogpile/Perplexity expose a free
-- per-site query or citation API to site owners (see
-- src/lib/ai-search-sources.ts for the capability classification), so a
-- recorded, timestamped manual test is the zero-cost source of truth for
-- all of them; Google is the one partial exception via
-- search_appearance_daily above.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_visibility_prompts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,

  prompt_text text not null check (char_length(prompt_text) between 1 and 500),
  category text not null check (category in ('observed', 'generated')),
  source_query text,

  created_at timestamptz not null default now()
);

create index if not exists ai_visibility_prompts_site_idx
  on public.ai_visibility_prompts (site_id);

create table if not exists public.ai_visibility_observations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  prompt_id uuid references public.ai_visibility_prompts (id) on delete set null,

  prompt_text text not null check (char_length(prompt_text) between 1 and 500),
  source text not null check (source in (
    'chatgpt', 'gemini', 'copilot', 'claude', 'siri', 'alexa', 'yahoo',
    'duckduckgo', 'brave', 'ecosia', 'dogpile', 'perplexity', 'other'
  )),

  observed_at timestamptz not null default now(),
  is_cited boolean,
  cited_url text,
  competitor_domain text,
  country text,
  device text check (device is null or device in ('desktop', 'mobile')),
  notes text check (notes is null or char_length(notes) <= 500)
);

create index if not exists ai_visibility_observations_site_idx
  on public.ai_visibility_observations (site_id, observed_at desc);
create index if not exists ai_visibility_observations_source_idx
  on public.ai_visibility_observations (site_id, source);

alter table public.ai_visibility_prompts enable row level security;
alter table public.ai_visibility_observations enable row level security;

drop policy if exists "ai_visibility_prompts admin select"
  on public.ai_visibility_prompts;
create policy "ai_visibility_prompts admin select"
  on public.ai_visibility_prompts as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "ai_visibility_prompts require aal2"
  on public.ai_visibility_prompts;
create policy "ai_visibility_prompts require aal2"
  on public.ai_visibility_prompts as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "ai_visibility_observations admin select"
  on public.ai_visibility_observations;
create policy "ai_visibility_observations admin select"
  on public.ai_visibility_observations as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "ai_visibility_observations require aal2"
  on public.ai_visibility_observations;
create policy "ai_visibility_observations require aal2"
  on public.ai_visibility_observations as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on
  public.ai_visibility_prompts, public.ai_visibility_observations
  to authenticated;
revoke all on
  public.ai_visibility_prompts, public.ai_visibility_observations
  from anon;
grant select, insert, update, delete on
  public.ai_visibility_prompts, public.ai_visibility_observations
  to service_role;

-- ---------------------------------------------------------------------------
-- Extend retention. search_appearance_daily follows the other GSC
-- breakdowns (210 days). ai_visibility_observations follows rank_snapshots
-- (365 days) - it's a comparable manual-observation history. Prompts and
-- competitor_domains-style config tables are never pruned.
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
      'ai_visibility_observations', v_ai_obs
    )
  );
end;
$$;

revoke all on function public.prune_portfolio_data(boolean) from public;
revoke all on function public.prune_portfolio_data(boolean) from anon, authenticated;
