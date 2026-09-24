-- 0019_bing_ai_performance_snapshots.sql
-- Bing Webmaster Tools AI Performance is available in the portal but, as of
-- 2026-09-24, Microsoft has not published a supported Webmaster API endpoint
-- for its citation/grounding-query dataset. Store explicitly sourced manual
-- snapshots separately so Ninja Analytics can show the evidence without
-- pretending it is API-synced.

create table if not exists public.bing_ai_performance_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  captured_at timestamptz not null default now(),
  range_label text not null,
  total_citations integer not null check (total_citations >= 0),
  average_cited_pages numeric,
  source text not null default 'manual_bwt_export',
  notes text
);

create table if not exists public.bing_ai_cited_pages (
  snapshot_id uuid not null references public.bing_ai_performance_snapshots(id) on delete cascade,
  page_url text not null,
  citations integer not null check (citations >= 0),
  primary key (snapshot_id, page_url)
);

create index if not exists bing_ai_snapshots_site_captured_idx
  on public.bing_ai_performance_snapshots(site_id, captured_at desc);

alter table public.bing_ai_performance_snapshots enable row level security;
alter table public.bing_ai_cited_pages enable row level security;

drop policy if exists "bing_ai_performance_snapshots admin select" on public.bing_ai_performance_snapshots;
create policy "bing_ai_performance_snapshots admin select"
  on public.bing_ai_performance_snapshots as permissive for select to authenticated
  using (public.is_portfolio_admin());

drop policy if exists "bing_ai_performance_snapshots require aal2" on public.bing_ai_performance_snapshots;
create policy "bing_ai_performance_snapshots require aal2"
  on public.bing_ai_performance_snapshots as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "bing_ai_cited_pages admin select" on public.bing_ai_cited_pages;
create policy "bing_ai_cited_pages admin select"
  on public.bing_ai_cited_pages as permissive for select to authenticated
  using (public.is_portfolio_admin());

drop policy if exists "bing_ai_cited_pages require aal2" on public.bing_ai_cited_pages;
create policy "bing_ai_cited_pages require aal2"
  on public.bing_ai_cited_pages as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.bing_ai_performance_snapshots, public.bing_ai_cited_pages to authenticated;
revoke all on public.bing_ai_performance_snapshots, public.bing_ai_cited_pages from anon;
grant select, insert, update, delete on public.bing_ai_performance_snapshots, public.bing_ai_cited_pages to service_role;

do $$
declare
  v_snapshot uuid;
begin
  if not exists (
    select 1 from public.bing_ai_performance_snapshots
    where site_id='287f1a0c-f617-4ca2-8d5c-fb8647e39c23'
      and source='manual_bwt_screenshot_2026-09-24'
  ) then
    insert into public.bing_ai_performance_snapshots
      (site_id, captured_at, range_label, total_citations, average_cited_pages, source, notes)
    values
      ('287f1a0c-f617-4ca2-8d5c-fb8647e39c23',
       '2026-09-24T15:06:59+01:00',
       '3 months',
       5,
       0,
       'manual_bwt_screenshot_2026-09-24',
       'Bing Webmaster Tools AI Performance screenshot supplied by owner; citations shown on 20 Sep 2026.')
    returning id into v_snapshot;

    insert into public.bing_ai_cited_pages(snapshot_id, page_url, citations) values
      (v_snapshot, 'https://ninjatickets.com/guides/reading-festival-2026-tickets-guide/', 4),
      (v_snapshot, 'https://ninjatickets.com/event/blackpool-80s-weekender-2026/', 1);
  end if;
end $$;
