# Ninja Analytics setup

This fork is the self-hosted analytics control plane for NinjaTickets.

## Target architecture

- Google Search Console: search queries, pages, clicks, impressions, CTR, position
- Google Analytics 4: sessions, engagement, landing pages, events and conversions
- Bing Webmaster Tools: Bing/Yahoo/DuckDuckGo search and crawl data
- Supabase: Auth, Postgres, Edge Functions and scheduled syncs
- Cloudflare Pages: static dashboard hosting
- NinjaTickets integrations to add after base deployment: IndexNow state, sitemap/indexing monitoring, affiliate click/revenue reporting, and AI/MCP access

## Immediate deployment checklist

1. Create a new Supabase project dedicated to Ninja Analytics.
2. Apply the repository migrations in `supabase/migrations/` in filename order.
3. Create one Google Cloud project and enable:
   - Google Search Console API
   - Google Analytics Data API
4. Create Google OAuth credentials using read-only Search Console and Analytics scopes.
5. Create a Bing Webmaster Tools API key.
6. Add the required provider credentials only as Supabase Edge Function secrets. Never commit secrets to GitHub.
7. Deploy the eight Supabase Edge Functions listed in the upstream README.
8. Create the single admin user and enable TOTP MFA.
9. Connect this repository to Cloudflare Pages.
10. Add NinjaTickets first and validate GSC, GA4 and Bing syncs before adding other sites.

## NinjaTickets values already known

- Search Console property: `sc-domain:ninjatickets.com`
- GA4 property display name: `NinjaTickets`
- GA4 property ID: `553851848`
- GA4 measurement ID: `G-WVETHDGV1X`
- GTM container: `GTM-WDFCV896`
- Sitemap: `https://ninjatickets.com/sitemap.xml`

## Safety rules

- Start read-only for Google and Bing data.
- Do not store OAuth refresh tokens, client secrets or Bing API keys in Git.
- Keep the dashboard `noindex` and private.
- Do not enable automated site changes until reporting accuracy has been compared against Google/Bing source dashboards.
- Keep GSC Wizard available during migration until Ninja Analytics has successfully reproduced the important reports.

## Migration goal before the GSC Wizard trial ends

Export or reproduce the useful NinjaTickets reporting we currently rely on: GSC query/page history, GA4 landing-page and event reporting, sitemap visibility, indexing observations and Bing data once connected. After validation, Ninja Analytics becomes the permanent £0/month data layer.
