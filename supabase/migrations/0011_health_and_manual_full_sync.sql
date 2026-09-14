-- 0011_health_and_manual_full_sync.sql
-- Two operator conveniences (brief: "Ninja Analytics Operations"):
--
--   * public.ninja_analytics_health() - one call that answers "is everything
--     working?": last GSC/GA4/Bing sync per site, last uptime check per site,
--     latest error per integration, core table row counts, and whether the
--     five site-analytics-* cron jobs exist and are active.
--
--   * public.run_all_analytics_syncs() - one call that fires GSC + GA4 + Bing
--     + uptime, instead of four separate `select invoke_scheduled_sync(...)`
--     statements. Same Vault-secret + net.http_post pattern as
--     invoke_scheduled_sync/invoke_scheduled_uptime (0005/0009) - it does not
--     duplicate the sync logic, only the dispatch.
--
-- Both functions:
--   * are read-only or dispatch-only - neither touches provider credentials,
--     billing, DNS, or anything outside this schema.
--   * self-guard like get_db_usage()/run_cleanup() (0007/0008): portfolio
--     admin on an aal2 (MFA-verified) session - EXCEPT when connected directly
--     as `postgres` / `supabase_admin` (the SQL editor), the same recovery
--     carve-out already used by guard_mfa_factor_change() (0003), so the
--     project owner can run them without a browser session.
--
--     The check below uses session_user, NOT current_user: both functions are
--     SECURITY DEFINER, so current_user inside the body is always the function
--     OWNER, not the caller - checking current_user here would silently accept
--     every caller. session_user is set once at connection time and is
--     unaffected by SECURITY DEFINER or SET ROLE, so it reliably reflects who
--     actually connected (PostgREST always connects as a pooling role such as
--     `authenticator`, never as `postgres`, so browser calls always take the
--     strict admin+aal2 path).

create or replace function public.ninja_analytics_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if session_user not in ('postgres', 'supabase_admin') then
    if not public.is_portfolio_admin() then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
      raise exception 'mfa required' using errcode = '42501';
    end if;
  end if;

  select jsonb_build_object(
    'captured_at', now(),

    'sites', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'site_id', s.id,
            'name', s.name,
            'domain', s.domain,
            'is_active', s.is_active,
            'integrations', (
              select jsonb_object_agg(
                i.source,
                jsonb_build_object(
                  'enabled', i.enabled,
                  'last_status', i.last_status,
                  'last_attempt_at', i.last_attempt_at,
                  'last_success_at', i.last_success_at,
                  'consecutive_failures', i.consecutive_failures,
                  'last_error_code', i.last_error_code,
                  'last_error_message', i.last_error_message,
                  'stale_after_hours', i.stale_after_hours
                )
              )
              from public.integration_status i
              where i.site_id = s.id
            ),
            'uptime', (
              select jsonb_build_object(
                'last_checked_at', u.checked_at,
                'ok', u.ok,
                'status_code', u.status_code,
                'latency_ms', u.latency_ms,
                'error', u.error
              )
              from public.uptime_checks u
              where u.site_id = s.id
              order by u.checked_at desc
              limit 1
            )
          )
          order by s.name
        )
        from public.sites s
      ),
      '[]'::jsonb
    ),

    'row_counts', jsonb_build_object(
      'sites', (select count(*) from public.sites),
      'analytics_daily', (select count(*) from public.analytics_daily),
      'search_daily', (select count(*) from public.search_daily),
      'search_query_daily', (select count(*) from public.search_query_daily),
      'search_page_daily', (select count(*) from public.search_page_daily),
      'sync_runs', (select count(*) from public.sync_runs),
      'integration_status', (select count(*) from public.integration_status),
      'uptime_checks', (select count(*) from public.uptime_checks),
      'tracked_queries', (select count(*) from public.tracked_queries)
    ),

    'cron_jobs', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'jobname', c.jobname,
            'schedule', c.schedule,
            'active', c.active
          )
          order by c.jobname
        )
        from cron.job c
        where c.jobname in (
          'site-analytics-sync-gsc',
          'site-analytics-sync-ga4',
          'site-analytics-sync-bing',
          'site-analytics-cleanup',
          'site-analytics-uptime'
        )
      ),
      '[]'::jsonb
    )
  )
  into result;

  return result;
end;
$$;

revoke all on function public.ninja_analytics_health() from public;
revoke all on function public.ninja_analytics_health() from anon;
grant execute on function public.ninja_analytics_health() to authenticated;

-- ---------------------------------------------------------------------------
-- run_all_analytics_syncs: dispatch all four scheduled functions at once.
-- ---------------------------------------------------------------------------
-- pg_net is async - this returns the four dispatch request ids, not synced row
-- counts. Check public.ninja_analytics_health() or public.sync_runs /
-- public.uptime_checks a few seconds later for the actual outcome, same as a
-- cron-fired run.

create or replace function public.run_all_analytics_syncs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_source text;
  v_path text;
  v_request_id bigint;
  v_requests jsonb := '[]'::jsonb;
begin
  if session_user not in ('postgres', 'supabase_admin') then
    if not public.is_portfolio_admin() then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
      raise exception 'mfa required' using errcode = '42501';
    end if;
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'automation_secret';

  if v_url is null or v_secret is null then
    raise exception 'Missing Vault secret project_url or automation_secret';
  end if;

  for v_source, v_path in
    select * from (
      values
        ('gsc', 'scheduled-sync-gsc'),
        ('ga4', 'scheduled-sync-ga4'),
        ('bing', 'scheduled-sync-bing'),
        ('uptime', 'scheduled-uptime')
    ) as t(source, path)
  loop
    select net.http_post(
      url := v_url || '/functions/v1/' || v_path,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Automation-Secret', v_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    ) into v_request_id;

    v_requests := v_requests || jsonb_build_object(
      'source', v_source,
      'request_id', v_request_id
    );
  end loop;

  return jsonb_build_object(
    'triggered_at', now(),
    'requests', v_requests,
    'note', 'Dispatched async via pg_net. Re-run public.ninja_analytics_health() in a few seconds, or check public.sync_runs / public.uptime_checks, for the actual result.'
  );
end;
$$;

revoke all on function public.run_all_analytics_syncs() from public;
revoke all on function public.run_all_analytics_syncs() from anon;
grant execute on function public.run_all_analytics_syncs() to authenticated;

-- ---------------------------------------------------------------------------
-- Usage (run ad hoc; not part of the schema):
--
--   -- one-call health snapshot
--   select public.ninja_analytics_health();
--
--   -- one-call manual full sync (gsc + ga4 + bing + uptime)
--   select public.run_all_analytics_syncs();
-- ---------------------------------------------------------------------------
