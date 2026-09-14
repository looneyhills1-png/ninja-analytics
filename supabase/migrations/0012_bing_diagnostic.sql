-- 0012_bing_diagnostic.sql
--
-- TEMPORARY diagnostic infrastructure for auditing the live Bing Webmaster
-- integration end to end (site discovery, exact site-URL identity, raw
-- search-performance endpoints, embedded-error detection). Safe to keep or
-- drop later - it never runs on a schedule and writes only to its own table.
--
-- Mirrors 0005_cron_jobs.sql's invoke_scheduled_sync() pattern exactly: a
-- SECURITY DEFINER function reads project_url/automation_secret from Vault
-- (never exposed to GitHub Actions or logged) and fires an async
-- net.http_post at the diagnose-bing Edge Function. The function itself
-- writes its full report - with the Bing API key redacted to a sha256
-- fingerprint + last 4 chars, never the raw value - into
-- public.bing_diagnostic_runs, which this migration also creates.

create table if not exists public.bing_diagnostic_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  report jsonb not null
);

revoke all on public.bing_diagnostic_runs from public, anon, authenticated;
grant select, insert on public.bing_diagnostic_runs to service_role;

create or replace function public.invoke_diagnose_bing()
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
    url := v_url || '/functions/v1/diagnose-bing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Automation-Secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 45000
  );
end;
$$;

revoke all on function public.invoke_diagnose_bing() from public;
revoke all on function public.invoke_diagnose_bing() from anon, authenticated;
