-- 0021_fix_workflow.sql
-- PART 1 of the 2026-09-24 SEO Fix Workflow + Bing Visibility brief: turns
-- the existing "Generate Fix Prompt" (copy-paste to Claude) into a real,
-- audited automation state machine inside Ninja Analytics.
--
-- fix_runs is the audit trail the brief asked for verbatim - one row per Fix
-- click, carrying every field §8 of the brief requires: query, URL, evidence
-- used, proposed fixes, rejected fixes + reasons, files changed, commit
-- hash, deployment result, sitemap submission result, Google inspection
-- before/after, crawl timestamp before/after. Nothing here is ever deleted
-- by a normal run - only prune_portfolio_data's existing retention sweep
-- ages it out, same as sync_runs/url_inspection_history.
--
-- inspection_result_link (added to url_inspections/url_inspection_history)
-- is Google's own real deep link into the Search Console UI for that
-- inspection (inspectionResultLink in the URL Inspection API response) - the
-- brief explicitly requires "Never fabricate the Search Console inspection
-- URL", so this must be Google's own verbatim field, not a hand-built URL.
--
-- sitemap_submissions is a small log of Sitemaps API calls (sitemaps.submit)
-- so "verify sitemap submission status" has something real to read back -
-- the Sitemaps API itself doesn't expose a push notification, only
-- sitemaps.get, which this table's last_checked_* columns cache.

create table if not exists public.fix_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,

  query text not null,
  url text not null check (char_length(url) between 1 and 2000),

  state text not null default 'diagnosis_ready' check (state in (
    'diagnosis_ready', 'validating', 'rejected', 'editing', 'testing',
    'deploying', 'verifying_production', 'sitemap_submitted',
    'awaiting_recrawl', 'recrawled', 'indexed', 'failed'
  )),

  -- Evidence used to build the plan (GSC row, competing URLs, diagnosis,
  -- Site Audit snapshot, internal-link-graph suggestions, URL Inspection
  -- state at the time) - a frozen snapshot, not a live join, so the audit
  -- trail reads the same way months later even if the underlying data has
  -- moved on.
  evidence jsonb not null default '{}'::jsonb,

  -- What the validation/safety layer (_shared/fix-validation.ts) approved
  -- vs discarded, and why - every rejected item MUST carry a reason string;
  -- the API layer enforces this, not a DB constraint (jsonb shape).
  proposed_fixes jsonb not null default '[]'::jsonb,
  rejected_fixes jsonb not null default '[]'::jsonb,

  -- Execution record, filled in as the run progresses.
  files_changed jsonb,               -- [{path, before_sha, after_sha}]
  commit_sha text,
  commit_url text,
  github_run_id bigint,
  github_run_url text,
  deployment_result jsonb,           -- {status, conclusion, checkedAt}
  live_verification jsonb,           -- {checkedAt, matches, diffs}
  sitemap_submission_result jsonb,   -- {sitemapUrl, submittedAt, ok, status}
  google_inspection_before jsonb,
  google_inspection_after jsonb,
  crawl_time_before timestamptz,
  crawl_time_after timestamptz,

  deployed_at timestamptz,
  error_message text,

  created_by uuid, -- auth.users id of whoever clicked Fix
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fix_runs_site_state_idx
  on public.fix_runs (site_id, state);
create index if not exists fix_runs_active_idx
  on public.fix_runs (state)
  where state in ('deploying', 'verifying_production', 'sitemap_submitted', 'awaiting_recrawl');
create index if not exists fix_runs_site_created_idx
  on public.fix_runs (site_id, created_at desc);

alter table public.fix_runs enable row level security;

drop policy if exists "fix_runs admin select" on public.fix_runs;
create policy "fix_runs admin select"
  on public.fix_runs as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "fix_runs require aal2" on public.fix_runs;
create policy "fix_runs require aal2"
  on public.fix_runs as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.fix_runs to authenticated;
revoke all on public.fix_runs from anon;
grant select, insert, update, delete on public.fix_runs to service_role;

-- ---------------------------------------------------------------------------
-- Google's own real deep link for a URL Inspection result (inspectionResult
-- Link in the API response) - never fabricated. Nullable: older cached rows
-- predate this column and simply don't have it until next inspected.
-- ---------------------------------------------------------------------------
alter table public.url_inspections
  add column if not exists inspection_result_link text;
alter table public.url_inspection_history
  add column if not exists inspection_result_link text;

-- ---------------------------------------------------------------------------
-- Sitemaps API submission log (sitemaps.submit / sitemaps.get).
-- ---------------------------------------------------------------------------
create table if not exists public.sitemap_submissions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  fix_run_id uuid references public.fix_runs (id) on delete set null,

  sitemap_url text not null check (char_length(sitemap_url) between 1 and 2000),
  submitted_at timestamptz not null default now(),
  submit_ok boolean not null,
  submit_status int,
  submit_error text,

  -- Last time sitemaps.get was called to check on this submission, and what
  -- Google reported (lastDownloaded, isPending, warnings/errors counts) -
  -- verbatim, never invented.
  last_checked_at timestamptz,
  last_checked_result jsonb
);

create index if not exists sitemap_submissions_site_idx
  on public.sitemap_submissions (site_id, submitted_at desc);

alter table public.sitemap_submissions enable row level security;

drop policy if exists "sitemap_submissions admin select" on public.sitemap_submissions;
create policy "sitemap_submissions admin select"
  on public.sitemap_submissions as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "sitemap_submissions require aal2" on public.sitemap_submissions;
create policy "sitemap_submissions require aal2"
  on public.sitemap_submissions as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

grant select on public.sitemap_submissions to authenticated;
revoke all on public.sitemap_submissions from anon;
grant select, insert, update, delete on public.sitemap_submissions to service_role;

-- ---------------------------------------------------------------------------
-- Scheduled state-machine advancement (checks GitHub Actions run status,
-- verifies the live page, re-inspects with Google, watches for recrawl) -
-- same Vault-secret + net.http_post pattern as every other cron job in this
-- project. Every 15 minutes, but advance-fix-runs itself no-ops immediately
-- (no HTTP calls at all) when there are zero active fix_runs, so this never
-- burns URL Inspection quota or GitHub API calls when nothing is in flight -
-- "no wasteful deploy polling" (CLAUDE.md).
-- ---------------------------------------------------------------------------
create or replace function public.invoke_advance_fix_runs()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'automation_secret';

  if v_url is null or v_secret is null then
    raise exception 'Missing Vault secret project_url or automation_secret';
  end if;

  perform net.http_post(
    url := v_url || '/functions/v1/advance-fix-runs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Automation-Secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function public.invoke_advance_fix_runs() from public;
revoke all on function public.invoke_advance_fix_runs() from anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'site-analytics-advance-fix-runs') then
    perform cron.unschedule('site-analytics-advance-fix-runs');
  end if;
end;
$$;

select cron.schedule(
  'site-analytics-advance-fix-runs', '*/15 * * * *',
  $$select public.invoke_advance_fix_runs()$$
);
