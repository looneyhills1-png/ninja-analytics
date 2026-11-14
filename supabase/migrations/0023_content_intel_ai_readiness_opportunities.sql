-- 0023_content_intel_ai_readiness_opportunities.sql
-- NEURONwriter content intelligence, AI readiness audits, the unified
-- opportunities queue, sampled-observation provenance and collector guards.
--
-- Additive and idempotent. Nothing existing is altered except three nullable /
-- defaulted columns on ai_visibility_observations and the ga4_breakdown_daily
-- dimension check (widened). Rollback: supabase/rollback/0023_down.sql.

-- ---------------------------------------------------------------------------
-- Collector guard: per-provider circuit breaker + daily call quota.
-- ---------------------------------------------------------------------------
create table if not exists public.collector_state (
  provider text primary key,
  consecutive_failures integer not null default 0,
  open_until timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  last_error_message text,
  calls_today integer not null default 0,
  calls_day date not null default current_date
);

-- ---------------------------------------------------------------------------
-- NEURONwriter (documented endpoints only: list-projects, list-queries,
-- get-query). We never call new-query, so no analysis credits are consumed.
-- ---------------------------------------------------------------------------
create table if not exists public.neuron_projects (
  neuron_project_id text primary key,
  name text not null,
  engine text,
  language text,
  site_id uuid references public.sites (id) on delete set null,
  fetched_at timestamptz not null default now()
);

create table if not exists public.neuron_analyses (
  neuron_query_id text primary key,
  neuron_project_id text not null
    references public.neuron_projects (neuron_project_id) on delete cascade,
  site_id uuid references public.sites (id) on delete set null,
  keyword text not null,
  status text not null,
  source text,
  created_src timestamptz,
  updated_src timestamptz,
  content_score numeric,
  terms jsonb,
  questions jsonb not null default '[]'::jsonb,
  competitors jsonb not null default '[]'::jsonb,
  page_url text,
  fetched_at timestamptz not null default now()
);

create index if not exists neuron_analyses_site_idx
  on public.neuron_analyses (site_id, updated_src desc);
create index if not exists neuron_analyses_project_idx
  on public.neuron_analyses (neuron_project_id);

-- ---------------------------------------------------------------------------
-- AI readiness audit (bounded technical checks on owned sites).
-- ---------------------------------------------------------------------------
create table if not exists public.ai_readiness_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  trigger_type text not null check (trigger_type in ('scheduled', 'manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'success', 'partial', 'failed')),
  pages_checked integer not null default 0,
  error_code text
);

create index if not exists ai_readiness_runs_site_idx
  on public.ai_readiness_runs (site_id, started_at desc);

create table if not exists public.ai_readiness_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ai_readiness_runs (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  check_key text not null,
  severity text not null check (severity in ('error', 'warning', 'notice', 'ok')),
  url text,
  message text not null,
  evidence jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);

create index if not exists ai_readiness_findings_run_idx
  on public.ai_readiness_findings (run_id);
create index if not exists ai_readiness_findings_site_idx
  on public.ai_readiness_findings (site_id, checked_at desc);

-- ---------------------------------------------------------------------------
-- Unified opportunities queue. dedupe_key makes rebuilds idempotent; rows the
-- owner dismissed or marked done are never resurrected.
-- ---------------------------------------------------------------------------
create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  dedupe_key text not null,
  source text not null check (
    source in ('gsc', 'bing', 'ga4', 'neuronwriter', 'ai_readiness', 'ai_visibility')
  ),
  kind text not null,
  target_url text,
  title text not null,
  problem text not null,
  evidence jsonb not null default '{}'::jsonb,
  evidence_at timestamptz not null,
  proposal text not null,
  expected_impact text not null,
  impact_is_estimate boolean not null default true,
  effort text not null check (effort in ('low', 'medium', 'high')),
  priority integer not null check (priority between 0 and 100),
  requires_publish_approval boolean not null default true,
  status text not null default 'open' check (status in ('open', 'dismissed', 'done', 'resolved')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (site_id, dedupe_key)
);

create index if not exists opportunities_queue_idx
  on public.opportunities (status, priority desc);

-- ---------------------------------------------------------------------------
-- Sampled-observation provenance (never platform-wide data).
-- ---------------------------------------------------------------------------
alter table public.ai_visibility_observations
  add column if not exists collection_method text not null default 'manual',
  add column if not exists brand_mentioned boolean,
  add column if not exists cited_urls text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- GA4: allow an AI-referrer breakdown next to country/page_title/channel.
-- ---------------------------------------------------------------------------
alter table public.ga4_breakdown_daily
  drop constraint if exists ga4_breakdown_daily_dimension_check;
alter table public.ga4_breakdown_daily
  add constraint ga4_breakdown_daily_dimension_check
  check (dimension in ('country', 'page_title', 'channel', 'ai_referrer'));

-- ---------------------------------------------------------------------------
-- RLS: same model as the rest of the schema (admin + aal2 read; service role
-- writes).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'collector_state', 'neuron_projects', 'neuron_analyses',
    'ai_readiness_runs', 'ai_readiness_findings', 'opportunities'
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
    execute format('grant select on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;

-- The owner may dismiss / complete an opportunity from the dashboard.
drop policy if exists "opportunities admin update" on public.opportunities;
create policy "opportunities admin update"
  on public.opportunities as permissive for update to authenticated
  using (public.is_portfolio_admin()) with check (public.is_portfolio_admin());
drop policy if exists "opportunities aal2 update" on public.opportunities;
create policy "opportunities aal2 update"
  on public.opportunities as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
revoke update on public.opportunities from authenticated;
grant update (status) on public.opportunities to authenticated;

-- ---------------------------------------------------------------------------
-- Scheduling. Mirrors invoke_scheduled_sync (secrets from Vault, never inline).
-- Weekly readiness audit; daily opportunities rebuild; daily NEURONwriter
-- read (the function is a no-op until NEURONWRITER_API_KEY is configured).
-- ---------------------------------------------------------------------------
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
    'ai-referrals-sync'
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
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function public.invoke_scheduled_function(text) from public;
revoke all on function public.invoke_scheduled_function(text) from anon, authenticated;

do $$
declare
  j text;
begin
  for j in select jobname from cron.job where jobname like 'ninja-intel-%' loop
    perform cron.unschedule(j);
  end loop;
end;
$$;

select cron.schedule('ninja-intel-neuron', '30 4 * * *',
  $$select public.invoke_scheduled_function('neuron-sync')$$);
select cron.schedule('ninja-intel-ai-referrals', '35 4 * * *',
  $$select public.invoke_scheduled_function('ai-referrals-sync')$$);
select cron.schedule('ninja-intel-opportunities', '45 4 * * *',
  $$select public.invoke_scheduled_function('build-opportunities')$$);
select cron.schedule('ninja-intel-readiness', '0 5 * * 1',
  $$select public.invoke_scheduled_function('ai-readiness-audit')$$);
