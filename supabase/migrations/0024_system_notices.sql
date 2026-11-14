-- 0024_system_notices.sql
-- Owner-facing, non-disruptive notices shown on the System page. First use:
-- the Google OAuth consent screen is in Testing status, so refresh tokens
-- expire after 7 days. The status itself cannot be read through the Google
-- APIs this app is authorised for, so it is recorded here when verified in
-- Google Cloud Console and the owner can mark it published.
--
-- Additive and idempotent. Rollback: supabase/rollback/0024_down.sql.

create table if not exists public.system_notices (
  key text primary key,
  severity text not null check (severity in ('info', 'warning')),
  title text not null,
  body text not null,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  dismissed_at timestamptz
);

alter table public.system_notices enable row level security;

drop policy if exists "system_notices admin select" on public.system_notices;
create policy "system_notices admin select"
  on public.system_notices as permissive for select to authenticated
  using (public.is_portfolio_admin());
drop policy if exists "system_notices require aal2" on public.system_notices;
create policy "system_notices require aal2"
  on public.system_notices as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

drop policy if exists "system_notices admin update" on public.system_notices;
create policy "system_notices admin update"
  on public.system_notices as permissive for update to authenticated
  using (public.is_portfolio_admin()) with check (public.is_portfolio_admin());
drop policy if exists "system_notices aal2 update" on public.system_notices;
create policy "system_notices aal2 update"
  on public.system_notices as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');

revoke all on public.system_notices from anon;
revoke all on public.system_notices from authenticated;
grant select on public.system_notices to authenticated;
grant update (dismissed_at, details) on public.system_notices to authenticated;
grant select, insert, update, delete on public.system_notices to service_role;

-- Verified in Google Cloud Console (Auth Platform > Audience) on 2026-11-14:
-- External, publishing status Testing. Token issued 2026-11-14 13:08 UTC.
insert into public.system_notices (key, severity, title, body, details, checked_at)
values (
  'google_oauth_testing',
  'warning',
  'Google access may expire after 7 days',
  'The Google OAuth consent screen is in Testing status, so Google expires the stored refresh token about 7 days after it is issued. Search Console and Analytics syncing will then stop until you re-authorise. Publishing the app (Google Auth Platform > Audience) avoids this; it is not done automatically.',
  jsonb_build_object(
    'publishing_status', 'testing',
    'user_type', 'external',
    'cloud_project', 'sunlit-cove-376310',
    'token_issued_at', '2026-11-14T13:08:11Z'
  ),
  '2026-11-14T13:30:00Z'
)
on conflict (key) do nothing;
