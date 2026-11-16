# Ninja Analytics MCP (private, read-only, live local data)

Lets ChatGPT interrogate Ninja Analytics directly: Google Search Console,
Bing, GA4 totals, URL coverage and inspection, site-audit findings,
opportunities and fix tracking, for every site in the portfolio. It replaces
GSC Wizard for these questions.

Every answer is real stored data with a source, a freshness verdict
(`fresh`, `stale`, `incomplete`, `unavailable`), the date window used and any
warnings. Nothing is fabricated: where Ninja Analytics does not store
something, the tool says so.

## How it works

```
ChatGPT ──(OpenAI Secure MCP Tunnel, outbound only)── tunnel-client ──► 127.0.0.1:47831/mcp
                                                                         │ bearer token
                                                              ninja-mcp (Node, no writes)
                                                                         │ role ninja_mcp_reader
                                                     local Postgres (SELECT on 24 tables)
```

- **Data source:** the existing local database that the scheduled GSC/GA4/Bing
  syncs already fill. The server never calls Google or Bing, so a question can
  never trigger a sync or use API quota.
- **Credential:** a dedicated Postgres role, `ninja_mcp_reader` (migration
  `0029_mcp_reader_role.sql`). It is not the service role, not the admin
  session and not the MFA user. It can only `SELECT` from an explicit table
  list, in read-only transactions with an 8 s statement timeout, and cannot see
  `auth`, `vault`, `cron`, OAuth tokens or `sites.publishing`. Its password and
  the bearer token live in `C:\Ninja\mcp\mcp.env` (per-user ACL, outside Git).
- **No free-form SQL.** Each tool is a fixed parameterised query. Text filters
  are bound parameters with LIKE wildcards escaped.
- **Limits:** 28-day default window, 180-day maximum, 100 rows per page with
  `offset` pagination, 4 concurrent / 240 per minute, 25 s deadline.
- **Network:** loopback only. Requests with a non-loopback `Host`, any browser
  `Origin`, or a missing/wrong bearer token are refused.

## Tools

| Tool | Answers |
| --- | --- |
| `list_sites` | Sites, integrations, last successful sync, fresh/stale |
| `site_overview` | Clicks, impressions, CTR, position, GA4 sessions/engagement vs previous period |
| `search_queries` | Google/Bing queries; filter, sort, compare, declining/rising/new/lost |
| `search_pages` | Same, per page URL |
| `query_page_map` | Which pages rank for which queries; cannibalisation filter |
| `search_breakdown` | Device, country, search type (28-day snapshot) |
| `ga4_report` | Daily sessions, users, views, engaged sessions, key events |
| `index_coverage` | Discovered / looked up / indexed / excluded + reasons, sitemaps; totals UNKNOWN until complete |
| `url_inspection` | Google URL Inspection results with timestamps + Ninja's live check |
| `technical_seo` | Latest crawl: health score, issues by type and exact URL |
| `content_intelligence` | Declining pages, low-CTR queries, near page one, lost queries, open opportunities |
| `ai_visibility` | Bing AI citations, Google search-appearance rows, manual observations |
| `compare_sites` | Every site, current vs previous period |
| `system_health` | Sync failures, stale sources, uptime |
| `fix_tracking` | Proposed / approved / blocked / deployed / verified changes |
| `describe_capabilities` | What is held per site and what is not available |

## GSC Wizard parity

| GSC Wizard capability | Ninja Analytics source | MCP tool | Status | Live test |
| --- | --- | --- | --- | --- |
| Search analytics by query | `search_query_daily` | `search_queries` | Fully supported | WW3 top queries match direct SQL exactly |
| By page | `search_page_daily` | `search_pages` | Fully supported | NinjaTickets declining pages returned |
| By date (daily series) | `search_daily` | `site_overview` (`include_daily`) | Fully supported | |
| Query to page | `search_query_page_daily` | `query_page_map` | Fully supported (rows Search Console returned at sync time) | |
| By country / device / search type | `search_dimension_snapshots` | `search_breakdown` | Partially: 28-day weekly snapshot, cannot be re-cut by date | |
| Date-range comparison | stored daily rows | `compare`, `compare_sites` | Fully supported | NinjaTickets -44.4% clicks |
| Bing queries/pages | `search_*` with engine=bing | same tools | Fully supported (data Bing exposes) | |
| GA4 totals and engagement | `analytics_daily` | `ga4_report`, `site_overview` | Partially: daily site totals only | |
| GA4 landing pages, channels, devices, countries, named conversion events | not stored | none | Missing (would need a new GA4 collector) | reported as `not_stored` |
| Affiliate / outbound click or revenue | not collected | none | Missing | |
| Indexed vs excluded, URL Inspection | `url_inspections`, `coverage_snapshots` | `index_coverage`, `url_inspection` | Partially: only URLs looked up so far, totals shown UNKNOWN until complete | WW3 36 of 36; NinjaTickets UNKNOWN |
| Search Console "Page indexing" and Core Web Vitals reports | none | none | Blocked by upstream: Google has no API | |
| Sitemaps | `gsc_sitemaps` | `index_coverage` | Fully supported (read-only) | |
| Technical problems | `site_audit_*` | `technical_seo` | Fully supported (Ninja's own crawl) | |
| Opportunities / refresh priorities | calculated | `content_intelligence` | Fully supported | |
| Portfolio-wide | all tables | `compare_sites`, `system_health` | Fully supported | |
| Fix tracking | `optimisation_changes`, `fix_runs` | `fix_tracking` | Fully supported | |

## Install on Recoil

1. Apply migration `0029` (creates the read-only role) and set its password
   out of band; store it in `C:\Ninja\mcp\mcp.env` with `NINJA_DB_USER`,
   `NINJA_DB_PASSWORD`, `NINJA_MCP_TOKEN` (see `smoke.mjs` for the variable names).
2. `powershell -File scripts\deploy-mcp.ps1` (installs to `C:\Ninja\ninja-mcp`,
   starts the `NinjaAnalytics-MCP` logon task, records the deployed commit).
3. Check it: `NINJA_MCP_ENV=C:\Ninja\mcp\mcp.env node tools/ninja-mcp/smoke.mjs`.

## Connect ChatGPT (owner steps, cannot be done from Recoil)

ChatGPT cannot reach `127.0.0.1`. Use OpenAI's Secure MCP Tunnel, which is
outbound-only (no router ports, no public endpoint).

1. In the OpenAI Platform organisation, create a tunnel
   (platform.openai.com/settings/organization/tunnels) and link it to your
   ChatGPT workspace. Create a Restricted runtime API key with
   Tunnels Read + Use only (not an admin key).
2. Download `tunnel-client` from github.com/openai/tunnel-client/releases/latest, then:

```powershell
$env:CONTROL_PLANE_API_KEY = "<runtime key>"
tunnel-client init --sample sample_mcp_remote_no_auth --profile ninja --tunnel-id <tunnel_id> --mcp-server-url http://127.0.0.1:47831/mcp
tunnel-client doctor --profile ninja --explain
tunnel-client run --profile ninja
```

3. In ChatGPT: Plugins, `+`, Add custom MCP server, Connection: Tunnel, pick the
   tunnel, set authentication to send `Authorization: Bearer <NINJA_MCP_TOKEN>`
   (or an API-key header if that is the option shown), create.
4. Ask: "List my Ninja Analytics sites" and confirm it returns real data.

Do not enable `NINJA_MCP_ALLOW_NO_AUTH` unless the tunnel is your only route and
you accept that the tunnel is then the only gate.

## Tests

`npx vitest run tools/ninja-mcp` (protocol, auth, validation, freshness, SQL
parameterisation). `node tools/ninja-mcp/smoke.mjs` calls every tool live.
Cost: none. No cloud service, no paid dependency (`pg` is MIT).
