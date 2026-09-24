-- 0020_bing_crawl_stats.sql
--
-- PART 2 of the 2026-09-24 SEO Fix Workflow + Bing Visibility brief.
--
-- Root cause of "0 Bing query-level rows / 0 Bing page-level rows" (confirmed
-- live via diagnose-bing 2026-09-24): Bing Webmaster API's GetQueryStats and
-- GetPageStats endpoints genuinely return real per-query/per-page rows for
-- this site (6 query rows, 3 page rows observed live) - the adapter
-- (_shared/bing.ts) simply never called them, only GetRankAndTrafficStats.
-- This was a missing-implementation gap, not an API limitation, a date-range
-- issue, or an auth/scope issue (GetUserSites already positively verifies
-- site access before any of this runs).
--
-- search_query_daily/search_page_daily already accept engine='bing' (see
-- 0006_search_breakdowns.sql) - no new table needed for query/page data, only
-- the adapter change (_shared/bing.ts) to actually call and write it.
--
-- This migration adds the one genuinely new table: bing_crawl_stats_daily,
-- for Bing's GetCrawlStats endpoint (also confirmed live and non-empty -
-- InIndex 56-68 and climbing, CrawledPages, CrawlErrors, BlockedByRobotsTxt
-- etc.) - real Bing discovery/crawl-health data with no Google equivalent
-- table, so it needs its own home rather than being forced into an existing
-- shape. Written idempotently per deploy-ninja-analytics.yml's fallback
-- convention.

create table if not exists public.bing_crawl_stats_daily (
  site_id uuid not null references public.sites (id) on delete cascade,
  metric_date date not null,

  crawled_pages bigint,
  in_index bigint,
  in_links bigint,
  crawl_errors bigint,
  dns_failures bigint,
  blocked_by_robots_txt bigint,
  code_2xx bigint,
  code_301 bigint,
  code_302 bigint,
  code_4xx bigint,
  code_5xx bigint,
  contains_malware bigint,
  connection_timeout bigint,
  all_other_codes bigint,

  updated_at timestamptz not null default now(),

  primary key (site_id, metric_date)
);

create index if not exists bing_crawl_stats_daily_site_date_idx
  on public.bing_crawl_stats_daily (site_id, metric_date desc);

alter table public.bing_crawl_stats_daily enable row level security;

drop policy if exists "bing_crawl_stats_daily admin select"
  on public.bing_crawl_stats_daily;
create policy "bing_crawl_stats_daily admin select"
  on public.bing_crawl_stats_daily as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "bing_crawl_stats_daily require aal2"
  on public.bing_crawl_stats_daily;
create policy "bing_crawl_stats_daily require aal2"
  on public.bing_crawl_stats_daily as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.bing_crawl_stats_daily to authenticated;
revoke all on public.bing_crawl_stats_daily from anon;
grant select, insert, update, delete on public.bing_crawl_stats_daily
  to service_role;
