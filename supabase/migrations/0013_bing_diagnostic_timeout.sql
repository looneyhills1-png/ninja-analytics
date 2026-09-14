-- 0013_bing_diagnostic_timeout.sql
--
-- The first live diagnose-bing invocation never landed a row in
-- bing_diagnostic_runs. diagnose-bing makes 6 sequential Bing API calls
-- (GetUserSites + 5 stats/crawl endpoints), each with its own retry/backoff
-- (_shared/http.ts fetchWithRetry: up to 3 retries, exponential backoff up
-- to 8s) - a single retried call alone can approach invoke_diagnose_bing()'s
-- 45s net.http_post timeout, and the cumulative worst case across 6 calls
-- comfortably exceeds it. Raise the timeout so a genuinely slow-but-working
-- run isn't aborted before it can insert its report.

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
    timeout_milliseconds := 150000
  );
end;
$$;

revoke all on function public.invoke_diagnose_bing() from public;
revoke all on function public.invoke_diagnose_bing() from anon, authenticated;
