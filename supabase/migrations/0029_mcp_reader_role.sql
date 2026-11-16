-- 0029_mcp_reader_role.sql
-- A dedicated, least-privilege, read-only database role for the private
-- Ninja Analytics MCP server (tools/ninja-mcp). It is deliberately NOT the
-- service role and NOT the dashboard's admin session:
--   * it can only SELECT, and only from the explicit table list below
--   * every transaction is read-only and limited to a few seconds
--   * it cannot see Vault, auth, OAuth tokens or the sites.publishing column
--   * it has its own login, with a password set out-of-band (never in Git)
--
-- Additive and idempotent. Rollback: supabase/rollback/0029_down.sql.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ninja_mcp_reader') then
    create role ninja_mcp_reader login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit 4;
  end if;
end;
$$;

alter role ninja_mcp_reader set default_transaction_read_only = on;
alter role ninja_mcp_reader set statement_timeout = '8s';
alter role ninja_mcp_reader set idle_in_transaction_session_timeout = '10s';
alter role ninja_mcp_reader set search_path = public;

grant usage on schema public to ninja_mcp_reader;

-- Tables the MCP tools read. Anything not listed here is invisible to it.
do $$
declare
  t text;
begin
  foreach t in array array[
    'analytics_daily', 'search_daily', 'search_query_daily',
    'search_page_daily', 'search_query_page_daily', 'search_appearance_daily',
    'search_dimension_snapshots', 'integration_status', 'sync_runs',
    'url_inspections', 'url_inventory', 'coverage_snapshots', 'gsc_sitemaps',
    'site_audit_runs', 'site_audit_issues', 'site_audit_pages',
    'opportunities', 'optimisation_changes', 'fix_runs',
    'bing_ai_performance_snapshots', 'bing_ai_cited_pages',
    'ai_visibility_observations', 'tracked_queries', 'uptime_checks'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on public.%I from ninja_mcp_reader', t);
      execute format('grant select on public.%I to ninja_mcp_reader', t);
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "%s mcp reader select" on public.%I', t, t);
      execute format(
        'create policy "%s mcp reader select" on public.%I as permissive for select to ninja_mcp_reader using (true)',
        t, t);
    end if;
  end loop;
end;
$$;

-- sites: column-level grant so the publishing configuration is not exposed.
revoke all on public.sites from ninja_mcp_reader;
grant select (id, name, domain, website_url, gsc_property, ga4_property_id,
  bing_site_url, is_active, created_at, updated_at, hosting_platform,
  hosting_project_id) on public.sites to ninja_mcp_reader;
drop policy if exists "sites mcp reader select" on public.sites;
create policy "sites mcp reader select" on public.sites
  as permissive for select to ninja_mcp_reader using (true);
