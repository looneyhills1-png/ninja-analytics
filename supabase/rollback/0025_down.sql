-- Rollback for 0025. The six workflow statuses collapse back to the four
-- legacy ones (new/validated/approved -> open, implemented -> done,
-- monitoring -> resolved, rejected -> dismissed); event and review history is
-- dropped with their tables. Opportunity rows themselves are kept.
drop trigger if exists opportunity_status_guard on public.opportunities;
drop function if exists public.opportunity_status_guard();

alter table public.opportunities drop constraint if exists opportunities_status_check;
update public.opportunities set status = case status
  when 'new' then 'open'
  when 'validated' then 'open'
  when 'approved' then 'open'
  when 'implemented' then 'done'
  when 'monitoring' then 'resolved'
  when 'rejected' then 'dismissed'
  else status end;
alter table public.opportunities alter column status set default 'open';
alter table public.opportunities add constraint opportunities_status_check
  check (status in ('open', 'dismissed', 'done', 'resolved'));

drop table if exists public.opportunity_reviews;
drop table if exists public.opportunity_events;

alter table public.opportunities
  drop constraint if exists opportunities_classification_check,
  drop constraint if exists opportunities_change_type_check,
  drop column if exists classification,
  drop column if exists recommended_change,
  drop column if exists change_type,
  drop column if exists baseline,
  drop column if exists after_metrics,
  drop column if exists original_priority,
  drop column if exists reviewed_at,
  drop column if exists owner_note,
  drop column if exists status_note,
  drop column if exists status_changed_at;

revoke update on public.opportunities from authenticated;
grant update (status) on public.opportunities to authenticated;
