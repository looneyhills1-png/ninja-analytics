# Self-hosted deployment (Windows, private)

Production runs on one Windows machine; nothing here is exposed to the internet.

| Part | Location |
| --- | --- |
| Supabase stack (Docker Compose) | `C:\Ninja\supabase` (database volume `ninja_analytics_db_data`) |
| Dashboard (static build) | `C:\Ninja\analytics-web`, served on `http://127.0.0.1:4173` |
| Local backups (keep 3) | `C:\Ninja\supabase\backups` |
| Offsite copies (keep 30) | `E:\NinjaAnalytics\backups` |

## Dashboard

```powershell
powershell -File scripts\deploy-local.ps1
```

Builds against `http://127.0.0.1:8000`, installs into `C:\Ninja\analytics-web`, records the
deployed commit in `DEPLOYED_COMMIT.txt`, and registers the logon task
`NinjaAnalytics-LocalDashboard` (`scripts/serve-local.mjs`, loopback only).

The stack's `.env` must list the local origin in `ALLOWED_APP_ORIGIN` (Edge Function CORS) and
`ADDITIONAL_REDIRECT_URLS` (Auth), then `docker compose up -d functions auth` to apply.

## Backups and restore test

`C:\Ninja\supabase\scripts\backup-ninja-analytics.ps1` (daily 02:00 task `NinjaAnalytics-DailyBackup`)
writes a `pg_dump -Fc` plus roles and row counts to C: and mirrors it to E:.
`restore-ninja-analytics.ps1 -BackupFolder <folder>` restores into a throwaway database
(`ninja_restore_test`), compares row counts, and drops it; it never touches live data without `-Live`.

## Google token (`invalid_grant`)

GSC/GA4 syncs fail with `invalid_grant` when `GOOGLE_REFRESH_TOKEN` is revoked or expired. An OAuth
consent screen in *Testing* status expires refresh tokens after 7 days. Re-mint with
`npm run oauth:google`, store the token only in the stack `.env`, and recreate the `functions` container.

## Rollback

Delete the `NinjaAnalytics-LocalDashboard` task and `C:\Ninja\analytics-web`; the hosted frontend and
the Supabase stack are unaffected by this change. The paused hosted project is kept as a cold source.
