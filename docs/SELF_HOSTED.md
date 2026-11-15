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

## Content intelligence, AI readiness and opportunities (migration 0023)

Apply `supabase/migrations/0023_*.sql` to the stack database (idempotent; rollback in
`supabase/rollback/0023_down.sql`) and copy the new `supabase/functions` folders and
`_shared` files into `C:\Ninja\supabase\volumes\functions`. Scheduled with pg_cron
(`ninja-intel-*`): NEURONwriter 04:30, AI referrals 04:35, opportunities 04:45 daily and the
AI-readiness audit Mondays 05:00.

- **NEURONwriter** (`neuron-sync`) is read-only: `list-projects`, `list-queries`, `get-query`.
  It never calls `new-query`. Set `NEURONWRITER_API_KEY` in the stack `.env` (Gold plan or
  higher) and recreate the `functions` container; without a key the function reports
  `api_key_not_configured` and does nothing.
- **AI referrals** (`ai-referrals-sync`) reads GA4 `sessionSource` using the existing Google
  grant, so it needs a valid `GOOGLE_REFRESH_TOKEN`.
- **AI readiness** crawls only the site's own host: 15 pages per run, 600 ms between requests,
  one retry, at most one run per 5 days when scheduled (10 minutes when manual).
- Every collector has a circuit breaker and a daily call quota in `collector_state`.
- Google's Search Generative AI report and Bing's AI Performance report have no documented API;
  they are shown as unsupported / manual and nothing is fabricated.

## Opportunity validation and workflow (migration 0025)

Apply `supabase/migrations/0025_*.sql` (rollback: `supabase/rollback/0025_down.sql`, which collapses the six
statuses back to four) and copy `validate-opportunities`, `build-opportunities` and the `_shared` files into
`C:\Ninja\supabase\volumes\functions`.

- **Workflow:** New → Validated → Approved → Implemented → Monitoring, plus Rejected. The database trigger
  enforces the allowed moves and writes every change (who, when, why) to `opportunity_events`. Nothing is
  deleted; the original finding and original priority stay on the row.
- **Validation** (`validate-opportunities`, button on the Opportunities page; deterministic, no AI): fetches the
  actual page on your own host (≤80 per run, 600 ms apart), strips site-wide boilerplate, matches keywords to pages
  by slug or page content, checks first-party Google/Bing demand, and classifies each item as Fix now, Content
  improvement, New content, Monitor or Reject. Each verdict is appended to `opportunity_reviews`.
- **Approval is yours.** `Approved` only records your decision. Ninja Analytics never publishes or edits a website.
- PostgREST caps every response at 1000 rows (`PGRST_DB_MAX_ROWS`); server code reads large tables with
  `fetchAllRows` pagination.

## Site optimisation, local AI and help text (migration 0026)

* `0026_site_optimisation.sql` adds `site_optimisation` (mode per site, default
  `monitor`), `optimisation_runs`, `optimisation_changes` and
  `optimisation_events` (append-only). Rollback: `supabase/rollback/0026_down.sql`.
  Copy `analyse-site`, `optimise-apply` and `_shared/optimise.ts` into
  `C:\Ninja\supabase\volumes\functions` after pulling.
* **Analyse & Optimise** (site detail page) runs the existing site audit when
  it is more than 7 days old, then `analyse-site`: read-only, deterministic, no
  AI. At most 12 analyses per site per day; repeats within a minute are reused.
* **Modes**: Monitor (default, read-only), Safe auto-fix (explicit owner
  action, type ENABLE), Approval required. In Safe auto-fix only the
  allowlisted change `meta_description_refresh` can be applied, only for sites
  with an authorised repository (NinjaTickets), at most 2 per analysis and 3
  per day, after: clean baseline, evidence gates (same as Run Fix), backup of
  the previous file, a diff of at most 4 lines, and a self-check. Applied
  changes are recorded in `fix_runs` so `advance-fix-runs` verifies the
  deployment. Rollback restores the exact backup and refuses if the file has
  changed since. Requires the `GITHUB_PAT` function secret (not set by this
  work).
* **Local AI**: `scripts/local-ai.mjs` talks only to Ollama on 127.0.0.1:11434
  (prefers `qwen3.5:9b`). 30 runs per day overall, 6 per site, identical
  requests cached for 6 hours, one at a time, 120 s timeout, at most two
  attempts. Usage persists in `local-ai-usage.json` next to `serve-local.mjs`.
  No Anthropic, Gemini or other external inference is used.
* **Help text**: every `Button` / `HelpButton` carries `help` (and `effect`:
  read, data, website). `src/test/controls-help.test.ts` fails if a control is
  added without it. `node scripts/audit-controls.mjs` lists them.

## Hosting and publishing capability (migration 0027)

* `sites.hosting_platform`, `hosting_project_id` and `publishing` record where a
  site is hosted and what Ninja Analytics can actually publish to it. WW3Supply
  is `chatgpt_sites` (project `appgprj_6adaf6cd38dc8191ab79c1f60fb79ecf`) with
  `ninjaCanPublish: false`: no publishing interface to the Sites project is
  configured, so every change for it is recorded with `deployment = 'blocked'`
  and its exact patch in `optimisation_changes.proposed_change`. Nothing is
  worked around. See `docs/proposed-changes/`.
* Recommendations never assume WordPress, `.htaccess`, Apache or Nginx.
* The site audit no longer counts a page whose canonical points at another URL
  (for example `/page/index.html` -> `/page/`) as a duplicate.
* Rollback: `supabase/rollback/0027_down.sql`.

## URL coverage and query intelligence (migration 0028)

* `coverage-sync` (daily cron `ninja-coverage-daily` 05:30, also on demand from
  a site's "Check coverage now") reads robots.txt, sitemap indexes and children,
  Search Console pages, the latest site audit, earlier inspections and internal
  links found on pages it checks. It live-checks and inspects only what is due
  (weekly staleness), with per-run budgets: 30 live checks and 30 Google
  inspections per site, 12 sitemaps, a 100 s wall clock shared equally between
  sites (45 s for an on-demand call, because the dashboard proxy cuts at 60 s).
  Large sites fill in over days (NinjaTickets: about 1,150 URLs at roughly 30 a
  day). Google allows 2,000 inspections a day per property; this uses a small
  fraction.
* Live facts are in `url_inventory`; Google's report stays in `url_inspections`
  and `url_inspection_history`. Site-wide indexed totals are UNKNOWN until every
  eligible URL has been inspected.
* `search_dimension_snapshots` holds weekly Search Analytics by device, country
  and search type. `gsc_sitemaps` holds Google's own sitemap status.
* Everything is read-only toward the sites and Google (read-only scope).
* Rollback: `supabase/rollback/0028_down.sql`.
* The Google "Page indexing" report and Core Web Vitals report are not exposed by
  any API, so they are not read.
