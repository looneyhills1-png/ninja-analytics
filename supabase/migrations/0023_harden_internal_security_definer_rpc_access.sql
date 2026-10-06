-- Source-control reconciliation for an already-applied production migration.
-- Production migration: harden_internal_security_definer_rpc_access
-- These statements are intentionally idempotent and preserve current live behavior.

revoke execute on function public.invoke_scheduled_catalogue_check() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
revoke execute on function public.seed_integration_status() from public, anon, authenticated;
