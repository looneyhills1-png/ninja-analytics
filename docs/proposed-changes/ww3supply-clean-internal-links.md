# WW3Supply: use clean internal links (proposed, NOT deployed)

Status: **BLOCKED**. No authorised publishing interface to ChatGPT Sites was found
for Ninja Analytics or Claude Code (none is configured in the repository, the
stack or the available tools), so nothing has been changed on ww3supply.com. This
file preserves the exact change to apply in the existing Sites project
`appgprj_6adaf6cd38dc8191ab79c1f60fb79ecf`.

## What was verified on the live site (2026-11-15)
* 10 blog pages load at both `/blog/<slug>/` and `/blog/<slug>/index.html` (HTTP 200 for both, no redirect).
* Every `/index.html` version already declares the clean address as its canonical, so search engines are told which to index.
* `sitemap.xml` lists 22 URLs and none end in `index.html`.
* The /index.html addresses are discoverable because the site's own links use them: 34 links across 10 pages (below).
* This is a low-urgency tidy-up, not a ranking emergency.

## The change
Replace the end of each of these `href` values: remove the trailing `index.html` (keep the slash). Nothing else changes.

### https://ww3supply.com/blog/
* `britain-without-electricity-6-24-72-hours/index.html` -> `britain-without-electricity-6-24-72-hours/`
* `community-first-72-hours/index.html` -> `community-first-72-hours/`
* `cyberwarfare-against-ordinary-people/index.html` -> `cyberwarfare-against-ordinary-people/`
* `microsoft-outage-russia-grey-zone-britain-resilience/index.html` -> `microsoft-outage-russia-grey-zone-britain-resilience/`
* `microsoft-outage-whats-on-your-pc-vs-cloud/index.html` -> `microsoft-outage-whats-on-your-pc-vs-cloud/`
* `uk-undersea-cable-threat-internet-banking/index.html` -> `uk-undersea-cable-threat-internet-banking/`
* `us-airspace-ground-stop-cost-2026/index.html` -> `us-airspace-ground-stop-cost-2026/`
* `us-flight-disruption-uk-europe-travel-update/index.html` -> `us-flight-disruption-uk-europe-travel-update/`
* `when-gas-supplies-are-disrupted/index.html` -> `when-gas-supplies-are-disrupted/`

### https://ww3supply.com/blog/britain-without-electricity-6-24-72-hours/
* `../community-first-72-hours/index.html` -> `../community-first-72-hours/`
* `../cyberwarfare-against-ordinary-people/index.html` -> `../cyberwarfare-against-ordinary-people/`
* `../index.html` -> `../`
* `../when-gas-supplies-are-disrupted/index.html` -> `../when-gas-supplies-are-disrupted/`

### https://ww3supply.com/blog/community-first-72-hours/
* `../britain-without-electricity-6-24-72-hours/index.html` -> `../britain-without-electricity-6-24-72-hours/`
* `../index.html` -> `../`
* `../when-gas-supplies-are-disrupted/index.html` -> `../when-gas-supplies-are-disrupted/`

### https://ww3supply.com/blog/cyberwarfare-against-ordinary-people/
* `../index.html` -> `../`
* `../microsoft-outage-russia-grey-zone-britain-resilience/index.html` -> `../microsoft-outage-russia-grey-zone-britain-resilience/`
* `../uk-undersea-cable-threat-internet-banking/index.html` -> `../uk-undersea-cable-threat-internet-banking/`

### https://ww3supply.com/blog/microsoft-outage-russia-grey-zone-britain-resilience/
* `../britain-without-electricity-6-24-72-hours/index.html` -> `../britain-without-electricity-6-24-72-hours/`
* `../community-first-72-hours/index.html` -> `../community-first-72-hours/`
* `../cyberwarfare-against-ordinary-people/index.html` -> `../cyberwarfare-against-ordinary-people/`
* `../index.html` -> `../`
* `../uk-undersea-cable-threat-internet-banking/index.html` -> `../uk-undersea-cable-threat-internet-banking/`
* `../when-gas-supplies-are-disrupted/index.html` -> `../when-gas-supplies-are-disrupted/`

### https://ww3supply.com/blog/microsoft-outage-whats-on-your-pc-vs-cloud/
* `../index.html` -> `../`

### https://ww3supply.com/blog/uk-undersea-cable-threat-internet-banking/
* `../britain-without-electricity-6-24-72-hours/index.html` -> `../britain-without-electricity-6-24-72-hours/`
* `../cyberwarfare-against-ordinary-people/index.html` -> `../cyberwarfare-against-ordinary-people/`
* `../index.html` -> `../`

### https://ww3supply.com/blog/us-airspace-ground-stop-cost-2026/
* `https://files.gao.gov/reports/GAO-26-107992/index.html` -> `https://files.gao.gov/reports/GAO-26-107992/`

### https://ww3supply.com/blog/us-flight-disruption-uk-europe-travel-update/
* `https://www.public.nm.eurocontrol.int/PUBPORTAL/gateway/spec/index.html` -> `https://www.public.nm.eurocontrol.int/PUBPORTAL/gateway/spec/`

### https://ww3supply.com/blog/when-gas-supplies-are-disrupted/
* `../britain-without-electricity-6-24-72-hours/index.html` -> `../britain-without-electricity-6-24-72-hours/`
* `../community-first-72-hours/index.html` -> `../community-first-72-hours/`
* `../index.html` -> `../`

## Not needed
No redirect, canonical or sitemap change is required. Do not apply WordPress, .htaccess, Apache or Nginx changes: the site is not hosted that way.

## After applying in the Sites project
Re-run Analyse & Optimise in Ninja Analytics (it runs a fresh site audit) and confirm the "pages are also reachable at /page/index.html" item no longer appears and no page links to an `index.html` address.
