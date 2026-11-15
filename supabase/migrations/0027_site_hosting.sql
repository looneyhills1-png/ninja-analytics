-- 0027_site_hosting.sql
-- Records where each website is hosted and what Ninja Analytics can actually
-- publish to it, so recommendations never assume a platform (for example
-- WordPress, .htaccess or a GitHub repository) a site does not use. Also lets
-- a proposed change carry its exact patch and a deployment status, so a change
-- that cannot be deployed from here is preserved and marked BLOCKED instead of
-- being worked around.
--
-- Additive and idempotent. Rollback: supabase/rollback/0027_down.sql.

alter table public.sites
  add column if not exists hosting_platform text not null default 'unknown',
  add column if not exists hosting_project_id text,
  add column if not exists publishing jsonb not null default '{}'::jsonb;

alter table public.sites drop constraint if exists sites_hosting_platform_check;
alter table public.sites
  add constraint sites_hosting_platform_check check (
    hosting_platform in (
      'unknown', 'chatgpt_sites', 'github_repo', 'wordpress', 'other'
    )
  );

alter table public.optimisation_changes
  add column if not exists proposed_change jsonb,
  add column if not exists deployment text not null default 'not_applicable',
  add column if not exists deployment_note text;

alter table public.optimisation_changes
  drop constraint if exists optimisation_changes_deployment_check;
alter table public.optimisation_changes
  add constraint optimisation_changes_deployment_check check (
    deployment in ('not_applicable', 'blocked', 'deployed', 'verified')
  );
