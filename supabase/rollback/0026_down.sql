-- Rollback for 0026. Drops the optimisation tables, triggers and functions.
-- Nothing on any website is affected; applied changes (if any) stay in the
-- site repositories and in fix_runs.
drop trigger if exists sites_optimisation_default on public.sites;
drop function if exists public.site_optimisation_default();
drop trigger if exists site_optimisation_mode_log on public.site_optimisation;
drop function if exists public.site_optimisation_mode_log();
drop table if exists public.optimisation_events;
drop table if exists public.optimisation_changes;
drop table if exists public.optimisation_runs;
drop table if exists public.site_optimisation;
