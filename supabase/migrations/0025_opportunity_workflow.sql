-- 0025_opportunity_workflow.sql
-- Opportunity workflow (New, Validated, Approved, Implemented, Monitoring,
-- Rejected), an append-only event history, and an audit table of validation
-- reviews. Original opportunity records are never deleted or overwritten:
-- the builder's original priority is kept and every status change and review
-- is recorded.
--
-- Additive and idempotent. Rollback: supabase/rollback/0025_down.sql (collapses
-- the six workflow statuses back to the four legacy ones).

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.opportunities
  add column if not exists classification text,
  add column if not exists recommended_change text,
  add column if not exists change_type text,
  add column if not exists baseline jsonb,
  add column if not exists after_metrics jsonb,
  add column if not exists original_priority integer,
  add column if not exists reviewed_at timestamptz,
  add column if not exists owner_note text,
  add column if not exists status_note text,
  add column if not exists status_changed_at timestamptz not null default now();

update public.opportunities set original_priority = priority
  where original_priority is null;

alter table public.opportunities
  drop constraint if exists opportunities_classification_check;
alter table public.opportunities
  add constraint opportunities_classification_check check (
    classification is null or classification in (
      'fix_now', 'content_improvement', 'new_content', 'monitor', 'reject'
    )
  );

alter table public.opportunities
  drop constraint if exists opportunities_change_type_check;
alter table public.opportunities
  add constraint opportunities_change_type_check check (
    change_type is null or change_type in ('edit', 'new_page', 'technical')
  );

-- ---------------------------------------------------------------------------
-- Status: legacy values map onto the workflow; nothing is dropped.
-- ---------------------------------------------------------------------------
alter table public.opportunities
  drop constraint if exists opportunities_status_check;

-- Keep the pre-migration status in the event history before rewriting it.
create table if not exists public.opportunity_events (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null
    references public.opportunities (id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,
  from_status text,
  to_status text not null,
  note text
);
create index if not exists opportunity_events_opp_idx
  on public.opportunity_events (opportunity_id, at);

do $$
begin
  -- Creation event for rows that have no history yet.
  insert into public.opportunity_events (opportunity_id, at, actor, from_status, to_status, note)
  select o.id, o.first_seen_at, 'system', null, 'new',
         'Created by the ' || o.source || ' builder (legacy status: ' || o.status || ')'
  from public.opportunities o
  where not exists (
    select 1 from public.opportunity_events e where e.opportunity_id = o.id
  );
end;
$$;

update public.opportunities set status = case status
  when 'open' then 'new'
  when 'dismissed' then 'rejected'
  when 'done' then 'implemented'
  when 'resolved' then 'monitoring'
  else status end
where status in ('open', 'dismissed', 'done', 'resolved');

alter table public.opportunities alter column status set default 'new';
alter table public.opportunities
  add constraint opportunities_status_check check (
    status in ('new', 'validated', 'approved', 'implemented', 'monitoring', 'rejected')
  );

-- ---------------------------------------------------------------------------
-- Transition guard + automatic history. Anything that changes `status` must
-- follow the workflow, and each change is recorded with who made it.
-- ---------------------------------------------------------------------------
create or replace function public.opportunity_status_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed text[];
begin
  if new.status is distinct from old.status then
    allowed := case old.status
      when 'new' then array['validated', 'rejected', 'monitoring']
      when 'validated' then array['approved', 'rejected', 'monitoring', 'new']
      when 'approved' then array['implemented', 'validated', 'rejected', 'monitoring']
      when 'implemented' then array['monitoring', 'new']
      when 'monitoring' then array['implemented', 'new', 'validated', 'rejected']
      when 'rejected' then array['new']
      else array[]::text[]
    end;
    if not (new.status = any (allowed)) then
      raise exception 'Invalid opportunity status change: % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    insert into public.opportunity_events (opportunity_id, actor, from_status, to_status, note)
    values (
      new.id,
      case when auth.uid() is null then 'system' else 'owner' end,
      old.status,
      new.status,
      nullif(new.status_note, '')
    );
    new.status_changed_at := now();
  end if;
  new.status_note := null;
  return new;
end;
$$;

drop trigger if exists opportunity_status_guard on public.opportunities;
create trigger opportunity_status_guard
  before update on public.opportunities
  for each row execute function public.opportunity_status_guard();

-- ---------------------------------------------------------------------------
-- Validation reviews: one row per automated review, never overwritten.
-- ---------------------------------------------------------------------------
create table if not exists public.opportunity_reviews (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null
    references public.opportunities (id) on delete cascade,
  reviewed_at timestamptz not null default now(),
  rules_version text not null,
  classification text not null check (
    classification in ('fix_now', 'content_improvement', 'new_content', 'monitor', 'reject')
  ),
  reasoning text not null,
  evidence jsonb not null default '{}'::jsonb
);
create index if not exists opportunity_reviews_opp_idx
  on public.opportunity_reviews (opportunity_id, reviewed_at desc);

-- ---------------------------------------------------------------------------
-- RLS / grants
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['opportunity_events', 'opportunity_reviews'] loop
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

revoke update on public.opportunities from authenticated;
grant update (status, status_note, owner_note) on public.opportunities to authenticated;
