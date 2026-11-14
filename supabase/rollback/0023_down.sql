-- Rollback for 0023. Drops only objects 0023 created and restores the two
-- widened/added bits on existing tables. Existing analytics data is untouched.
do $$
declare
  j text;
begin
  for j in select jobname from cron.job where jobname like 'ninja-intel-%' loop
    perform cron.unschedule(j);
  end loop;
end;
$$;

drop function if exists public.invoke_scheduled_function(text);
drop table if exists public.opportunities;
drop table if exists public.ai_readiness_findings;
drop table if exists public.ai_readiness_runs;
drop table if exists public.neuron_analyses;
drop table if exists public.neuron_projects;
drop table if exists public.collector_state;

alter table public.ai_visibility_observations
  drop column if exists collection_method,
  drop column if exists brand_mentioned,
  drop column if exists cited_urls;

delete from public.ga4_breakdown_daily where dimension = 'ai_referrer';
alter table public.ga4_breakdown_daily
  drop constraint if exists ga4_breakdown_daily_dimension_check;
alter table public.ga4_breakdown_daily
  add constraint ga4_breakdown_daily_dimension_check
  check (dimension in ('country', 'page_title', 'channel'));
