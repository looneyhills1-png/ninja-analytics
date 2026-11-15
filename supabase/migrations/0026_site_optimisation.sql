-- 0026_site_optimisation.sql
-- Per-site optimisation: a mode (monitor / safe_auto / approval_required), an
-- auditable record of every analysis run, every proposed or applied change
-- (with the before value needed to roll back), and an append-only event log.
--
-- Safe by default: every site starts in MONITOR (read-only). Nothing here
-- publishes anything; applying a change goes through the optimise-apply Edge
-- Function, which refuses unless the owner has switched the site to safe_auto.
-- Additive and idempotent. Rollback: supabase/rollback/0026_down.sql.

create table if not exists public.site_optimisation (
  site_id uuid primary key references public.sites (id) on delete cascade,
  mode text not null default 'monitor'
    check (mode in ('monitor', 'safe_auto', 'approval_required')),
  mode_changed_at timestamptz not null default now(),
  mode_changed_by text,
  last_run_id uuid,
  last_run_at timestamptz
);

insert into public.site_optimisation (site_id)
  select id from public.sites
  on conflict (site_id) do nothing;

create table if not exists public.optimisation_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  mode text not null,
  status text not null default 'success' check (status in ('success', 'failed')),
  health jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  error_message text
);
create index if not exists optimisation_runs_site_idx
  on public.optimisation_runs (site_id, started_at desc);

create table if not exists public.optimisation_changes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  run_id uuid references public.optimisation_runs (id) on delete set null,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  url text,
  title text not null,
  problem text not null,
  recommendation text not null,
  change_class text not null,
  risk text not null check (risk in ('low', 'substantial')),
  priority integer not null default 0,
  status text not null default 'proposed' check (status in (
    'proposed', 'needs_approval', 'applied', 'verified', 'rolled_back',
    'rejected', 'failed'
  )),
  auto_eligible boolean not null default false,
  evidence jsonb not null default '{}'::jsonb,
  -- Backup and result of an applied change (what is needed to roll back).
  before_value jsonb,
  after_value jsonb,
  repo text,
  file_path text,
  base_sha text,
  commit_sha text,
  rollback_sha text,
  fix_run_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists optimisation_changes_site_idx
  on public.optimisation_changes (site_id, created_at desc);

create table if not exists public.optimisation_events (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  change_id uuid references public.optimisation_changes (id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,
  event text not null,
  detail text
);
create index if not exists optimisation_events_site_idx
  on public.optimisation_events (site_id, at desc);

-- Every mode change is logged, with who made it.
create or replace function public.site_optimisation_mode_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.mode is distinct from old.mode then
    new.mode_changed_at := now();
    new.mode_changed_by := case when auth.uid() is null then 'system' else 'owner' end;
    insert into public.optimisation_events (site_id, actor, event, detail)
    values (new.site_id, new.mode_changed_by, 'mode_changed',
            old.mode || ' -> ' || new.mode);
  end if;
  return new;
end;
$$;
drop trigger if exists site_optimisation_mode_log on public.site_optimisation;
create trigger site_optimisation_mode_log
  before update on public.site_optimisation
  for each row execute function public.site_optimisation_mode_log();

-- New sites start in monitor mode.
create or replace function public.site_optimisation_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.site_optimisation (site_id) values (new.id)
  on conflict (site_id) do nothing;
  return new;
end;
$$;
drop trigger if exists sites_optimisation_default on public.sites;
create trigger sites_optimisation_default
  after insert on public.sites
  for each row execute function public.site_optimisation_default();

-- RLS / grants: admin + aal2 read; the owner may change only the mode.
do $$
declare
  t text;
begin
  foreach t in array array[
    'site_optimisation', 'optimisation_runs', 'optimisation_changes',
    'optimisation_events'
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

drop policy if exists "site_optimisation admin update" on public.site_optimisation;
create policy "site_optimisation admin update"
  on public.site_optimisation as permissive for update to authenticated
  using (public.is_portfolio_admin()) with check (public.is_portfolio_admin());
drop policy if exists "site_optimisation update require aal2" on public.site_optimisation;
create policy "site_optimisation update require aal2"
  on public.site_optimisation as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
grant update (mode) on public.site_optimisation to authenticated;
