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

## Access model (no login, this PC only)

The build uses `VITE_LOCAL_ACCESS=true`: no login or MFA screen. `scripts/serve-local.mjs` proxies
`/sb/rest/v1/*` and `/sb/functions/v1/*` to the gateway and attaches a 15-minute admin JWT minted from
the stack's `JWT_SECRET` (`scripts/local-access.mjs`). The browser only holds the publishable key.
RLS (including the `aal2` policies) and the Edge Function admin checks are unchanged.

Protection is the network boundary, so every proxied request must have a loopback `Host`, be
same-origin, carry `x-ninja-local: 1`, and have no Cloudflare/forwarding headers. Auth, storage,
realtime and the Postgres meta API are not reachable through the proxy.

**The public route must stay closed.** `volumes/api/envoy/lds.template.yaml` answers 401 to the
`supabase.ninjatickets.com` host and to any request carrying `cf-ray`/`cf-connecting-ip`. If that block is
ever removed, restore authentication (`VITE_LOCAL_ACCESS=false`) first.

To go back to password login: rebuild without `VITE_LOCAL_ACCESS` and reset the admin password in the
local database (`auth.users`) or via the Auth admin API with the service key.

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
