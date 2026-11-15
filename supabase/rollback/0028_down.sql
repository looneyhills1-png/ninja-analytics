-- Rollback for 0028. Removes the coverage tables and the daily job, and
-- restores the previous scheduled-function allow-list (without coverage-sync).
do $$
begin
  perform cron.unschedule('ninja-coverage-daily');
exception when others then
  null;
end;
$$;

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

drop table if exists public.search_dimension_snapshots;
drop table if exists public.gsc_sitemaps;
drop table if exists public.coverage_snapshots;
drop table if exists public.url_inventory;
