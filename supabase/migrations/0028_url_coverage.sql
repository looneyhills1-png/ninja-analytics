-- 0028_url_coverage.sql
-- Full-site URL coverage: an inventory of every discoverable URL per site
-- (sitemaps, internal links, Search Console pages, earlier crawls and
-- inspections), the live technical facts for each, and daily snapshots so
-- coverage can be compared over time. Google-reported index status stays in
-- url_inspections / url_inspection_history (unchanged); this table holds only
-- what Ninja Analytics itself observed, so the two are never mixed.
--
-- Also stores Google's own sitemap status (sitemaps.list, read-only) and
-- weekly Search Analytics snapshots by device, country and search type.
--
-- Additive and idempotent. Rollback: supabase/rollback/0028_down.sql.

create table if not exists public.url_inventory (
  site_id uuid not null references public.sites (id) on delete cascade,
  url text not null check (char_length(url) between 1 and 2000),
  sources text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  in_sitemap boolean not null default false,
  -- An alias (for example /page/index.html or a page whose canonical points
  -- elsewhere) and the URL it consolidates into.
  is_alias boolean not null default false,
  canonical_group text,
  -- Live technical facts (our own request, not Google's view).
  live_checked_at timestamptz,
  live_status integer,
  live_redirect_to text,
  live_canonical text,
  live_noindex boolean,
  live_title text,
  live_description text,
  live_has_schema boolean,
  live_word_count integer,
  live_error text,
  robots_allowed boolean,
  primary key (site_id, url)
);
create index if not exists url_inventory_site_idx
  on public.url_inventory (site_id, last_seen_at desc);

create table if not exists public.coverage_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  captured_at timestamptz not null default now(),
  discovered integer not null default 0,
  live_checked integer not null default 0,
  inspected integer not null default 0,
  indexed integer not null default 0,
  excluded integer not null default 0,
  unknown_state integer not null default 0,
  technical_errors integer not null default 0,
  complete boolean not null default false,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists coverage_snapshots_site_idx
  on public.coverage_snapshots (site_id, captured_at desc);

create table if not exists public.gsc_sitemaps (
  site_id uuid not null references public.sites (id) on delete cascade,
  path text not null,
  last_submitted timestamptz,
  last_downloaded timestamptz,
  is_pending boolean,
  is_sitemaps_index boolean,
  warnings integer,
  errors integer,
  contents jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now(),
  primary key (site_id, path)
);

create table if not exists public.search_dimension_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  captured_at timestamptz not null default now(),
  window_start date not null,
  window_end date not null,
  dimension text not null check (dimension in ('device', 'country', 'search_type')),
  key text not null,
  clicks numeric not null default 0,
  impressions numeric not null default 0,
  ctr numeric,
  position numeric
);
create index if not exists search_dimension_snapshots_site_idx
  on public.search_dimension_snapshots (site_id, dimension, captured_at desc);

-- Row level security: admin + aal2 read, service role writes.
do $$
declare
  t text;
begin
  foreach t in array array[
    'url_inventory', 'coverage_snapshots', 'gsc_sitemaps',
    'search_dimension_snapshots'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s admin select" on public.%I', t, t);
    execute format(
      'create policy "%s admin select" on public.%I as permissive for select to authenticated using (public.is_portfolio_admin())',
      t, t);
    execute format('drop policy if exists "%s require aal2" on public.%I', t, t);
    execute format(
      'create policy "%s require aal2" on public.%I as restrictive for select to authenticated using ((select auth.jwt() ->> ''aal'') = ''aal2'')',
      t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;

-- Allow the scheduled function list to include coverage-sync. Longer wait for
-- it because one bounded pass fetches pages and calls Google for each site.
create or replace function public.invoke_scheduled_function(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if p_name not in (
    'ai-readiness-audit', 'neuron-sync', 'build-opportunities',
    'ai-referrals-sync', 'coverage-sync'
  ) then
    raise exception 'Unknown scheduled function: %', p_name;
  end if;
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'automation_secret';
  if v_url is null or v_secret is null then
    raise exception 'Missing Vault secret project_url or automation_secret';
  end if;
  perform net.http_post(
    url := v_url || '/functions/v1/' || p_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Automation-Secret', v_secret
    ),
    body := '{"trigger":"scheduled"}'::jsonb,
    timeout_milliseconds := case when p_name = 'coverage-sync' then 150000 else 30000 end
  );
end;
$$;
revoke all on function public.invoke_scheduled_function(text) from public;
revoke all on function public.invoke_scheduled_function(text) from anon, authenticated;

-- One daily incremental pass (05:30). What is actually due is decided by
-- staleness rules inside the function (pages re-checked weekly, Google
-- inspections weekly), so the daily run touches only a small bounded batch.
do $$
begin
  perform cron.unschedule('ninja-coverage-daily');
exception when others then
  null;
end;
$$;
select cron.schedule('ninja-coverage-daily', '30 5 * * *',
  $$select public.invoke_scheduled_function('coverage-sync')$$);
