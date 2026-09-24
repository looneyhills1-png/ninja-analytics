-- 0018_gsc_coverage_snapshots.sql
-- Stores manually imported Google Search Console Coverage exports separately
-- from per-URL URL Inspection API results. This prevents the UI from implying
-- that "30 indexed" means Google only has 30 pages indexed.

create table if not exists public.gsc_coverage_snapshots (
  site_id uuid not null references public.sites(id) on delete cascade,
  metric_date date not null,
  coverage_label text not null default 'Valid',
  affected_pages integer not null check (affected_pages >= 0),
  sitemap text,
  imported_at timestamptz not null default now(),
  source text not null default 'search_console_export',
  primary key (site_id, metric_date, coverage_label)
);

alter table public.gsc_coverage_snapshots enable row level security;

drop policy if exists "gsc_coverage_snapshots admin select" on public.gsc_coverage_snapshots;
create policy "gsc_coverage_snapshots admin select"
  on public.gsc_coverage_snapshots as permissive for select to authenticated
  using (public.is_portfolio_admin());

drop policy if exists "gsc_coverage_snapshots require aal2" on public.gsc_coverage_snapshots;
create policy "gsc_coverage_snapshots require aal2"
  on public.gsc_coverage_snapshots as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.gsc_coverage_snapshots to authenticated;
revoke all on public.gsc_coverage_snapshots from anon;
grant select, insert, update, delete on public.gsc_coverage_snapshots to service_role;

insert into public.gsc_coverage_snapshots
  (site_id, metric_date, coverage_label, affected_pages, sitemap, source)
values
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-08-28','Valid',591,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-08-29','Valid',953,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-08-30','Valid',953,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-08-31','Valid',953,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-01','Valid',953,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-02','Valid',953,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-03','Valid',953,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-04','Valid',953,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-05','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-06','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-07','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-08','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-09','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-10','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-11','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-12','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-13','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-14','Valid',670,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-15','Valid',772,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-16','Valid',772,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-17','Valid',772,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-18','Valid',772,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-19','Valid',806,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-20','Valid',806,'https://ninjatickets.com/sitemap.xml','search_console_export'),
('287f1a0c-f617-4ca2-8d5c-fb8647e39c23','2026-09-21','Valid',806,'https://ninjatickets.com/sitemap.xml','search_console_export')
on conflict (site_id, metric_date, coverage_label) do update
set affected_pages=excluded.affected_pages,
    sitemap=excluded.sitemap,
    source=excluded.source,
    imported_at=now();
