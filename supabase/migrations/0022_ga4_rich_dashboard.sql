-- 0022_ga4_rich_dashboard.sql
-- Rich GA4 dashboard data: headline Event count / Key events plus the
-- country, page-title and acquisition-channel breakdowns shown on GA4 Home.

alter table public.analytics_daily
  add column if not exists event_count bigint not null default 0,
  add column if not exists key_events bigint not null default 0;

create table if not exists public.ga4_breakdown_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  metric_date date not null,
  dimension text not null check (dimension in ('country','page_title','channel')),
  dimension_value text not null,
  active_users bigint,
  sessions bigint,
  screen_page_views bigint,
  updated_at timestamptz not null default now(),
  primary key (site_id, metric_date, dimension, dimension_value)
);

create index if not exists ga4_breakdown_daily_site_date_idx
  on public.ga4_breakdown_daily(site_id, metric_date desc, dimension);

alter table public.ga4_breakdown_daily enable row level security;

drop policy if exists "ga4_breakdown_daily admin select" on public.ga4_breakdown_daily;
create policy "ga4_breakdown_daily admin select"
  on public.ga4_breakdown_daily as permissive for select to authenticated
  using (public.is_portfolio_admin());

drop policy if exists "ga4_breakdown_daily require aal2" on public.ga4_breakdown_daily;
create policy "ga4_breakdown_daily require aal2"
  on public.ga4_breakdown_daily as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.ga4_breakdown_daily to authenticated;
revoke all on public.ga4_breakdown_daily from anon;
grant select, insert, update, delete on public.ga4_breakdown_daily to service_role;
