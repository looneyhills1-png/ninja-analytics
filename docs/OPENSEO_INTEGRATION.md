# OpenSEO -> Ninja Analytics (local, read-only)

Status: integration code only. A running OpenSEO Docker instance, MCP authorization, and a successful Recoil deployment must be verified separately. Never label this integration "connected" just because its UI renders.

## Why a bridge, not an OpenSEO fork

Ninja Analytics already owns GSC/GA4/Bing, keyword opportunities, AI visibility, crawling and fix tracking. OpenSEO offers additional stored research evidence through its MCP endpoint. Reuse the existing dashboard; do not replace it or start an additional cloud collector.

Upstream: https://github.com/every-app/open-seo (MIT). Docker instructions: https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_DOCKER.md

## Cost and security

- Local dashboard: http://127.0.0.1:4173; OpenSEO: http://127.0.0.1:3001.
- Dashboard proxy checks the existing same-origin, loopback, custom-header gate.
- Seven allowlisted MCP tools only: list_projects, list_saved_keywords, get_rank_tracker, get_ai_visibility_tracker, get_ai_visibility_results, get_ai_visibility_sources, get_ai_visibility_trend.
- Stored evidence only, up to 25 AI rows and 50 saved keywords; 60 upstream read calls/hour; 60-second cache; no retries, schedulers or paid research/crawl/API calls.
- No credentials appear in the browser, source, URL, query string, commits or logs.
- OpenSEO may have independently enabled scheduled checks that spend provider credits; **disable them in OpenSEO**. This bridge cannot control them.
- Research/backlinks/search volume require paid DataForSEO or another provider. These are disabled. Do not set up billing or deposit credits without owner approval.
- Keep OpenSEO bound to loopback only, with no public tunnel.

## Local configuration

1. Precondition: OpenSEO exists and answers http://127.0.0.1:3001/api/health. It is NOT installed by Ninja Analytics. Do not start a new Docker stack blindly, particularly without a provider key or if port 3001 is occupied.
2. In local_noauth mode and only on loopback, the bridge can read without a key. For password mode, create an API key in OpenSEO Settings and save it, on the Recoil, in C:\Ninja\analytics-web\open-seo-api-key.txt (one line); never commit it. This file lives outside the served dist directory. Alternatively pass OPENSEO_API_KEY as a server process environment variable. Local file takes precedence.
3. From the Ninja Analytics repository root on Recoil deploy once with powershell -NoProfile -File scripts\deploy-local.ps1. This builds once, copies open-seo-bridge.mjs into the local install and restarts the dashboard task. It never deploys to Cloudflare or hosted Supabase.
4. Visit http://127.0.0.1:4173/open-seo on the Recoil. Select a website and click Connect & load free evidence. It reads only existing OpenSEO projects and saved snapshots.
5. Project mapping is by exact hostname, ignoring www. Add the project manually inside local OpenSEO if not already present.

## Acceptance criteria

- The CI suite must pass format, lint, typecheck, bridge tests and build.
- When Docker is stopped, the dashboard shows OpenSEO offline instead of making a claim of connection.
- With authorized MCP and a matching project, saved keyword data, existing rank tracker configs, AI comparison counts and cited sources appear with provenance.
- A paid tool requested via the local proxy returns a 400 and is never forwarded.
- The integration is not verified on the user's machine until it successfully loads actual OpenSEO data from the running Recoil instance.

This implementation does not import OpenSEO data to Supabase, execute SEO fixes, add migrations, create scheduled tasks, change DNS, or spend money. A future persistent sync must have explicit provenance, bounded quotas and approval gates.
