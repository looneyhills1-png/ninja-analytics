# Google services audit (2026-11-15)

Verified from the live OAuth token (scopes only; no secrets printed) and a live
PageSpeed call. The OAuth client lives in Cloud project `sunlit-cove-376310`.
Granted scopes: `analytics.readonly`, `webmasters.readonly`. Scopes were not
changed, billing was not touched, nothing was created.

| Service | Status | Notes |
| --- | --- | --- |
| Search Console | **Connected** | webmasters.readonly; daily collector healthy |
| Analytics 4 (data) | **Connected** | analytics.readonly; incl. AI referral sessions |
| GA4 Admin (property discovery) | Not authorised | API not enabled in the project; free to enable, owner action |
| PageSpeed Insights / Core Web Vitals | **BLOCKED** | Free API, but keyless calls hit the shared daily quota (HTTP 429 verified). Needs a free API key created in Cloud Console (a new credential, so needs the owner). |
| Chrome UX Report | BLOCKED | Free API; same API-key requirement |
| Google Trends | Unsupported | No official API; scraping is against its terms |
| Tag Manager | Not authorised | Would need a new OAuth scope; no analytic value without it |
| Google Ads (Keyword Planner) | Not authorised | Needs an Ads account and developer token; volumes only for active advertisers; potentially chargeable |
| Merchant Center / Business Profile | Not applicable | No shopping feed or local listing in use |
| Gemini / AI Studio | Not enabled | No key present; free-tier zero-spend cannot be enforced from here. Local AI remains the default policy; no paid fallback exists |
| Drive / Looker Studio | Not needed | Exports already available locally (CSV/PDF/JSON) |
| AI Overviews / AI Mode reporting | Unsupported | Search Console UI only, no API |

To unblock PageSpeed/CrUX later: create a free API key restricted to those two
APIs, then set `PAGESPEED_API_KEY` in `C:\Ninja\supabase\.env`. No code adapter
was added because it would be dead code until then.
