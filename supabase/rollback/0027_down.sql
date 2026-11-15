-- Rollback for 0027. Removes the hosting columns and the deployment fields.
alter table public.optimisation_changes
  drop constraint if exists optimisation_changes_deployment_check,
  drop column if exists proposed_change,
  drop column if exists deployment,
  drop column if exists deployment_note;
alter table public.sites
  drop constraint if exists sites_hosting_platform_check,
  drop column if exists hosting_platform,
  drop column if exists hosting_project_id,
  drop column if exists publishing;
