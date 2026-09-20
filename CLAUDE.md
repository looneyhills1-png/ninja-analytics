# Ninja Analytics — project instructions

## Mission

Build Ninja Analytics into a self-hosted SEO intelligence platform that looks and behaves like a professional Semrush/GSC Wizard-style product, while remaining under the owner's control.

The priority is actionable SEO intelligence, not decorative charts.

## HARD RULE: zero paid data subscriptions

The owner does NOT want to pay for Semrush, Ahrefs, DataForSEO, SerpApi, Moz, Majestic, Ubersuggest Pro, or another recurring SEO-data provider.

Do not implement a feature by adding a paid API dependency unless the owner explicitly changes this rule.

Prefer:
- Google Search Console
- Google Analytics 4
- Bing Webmaster Tools
- direct first-party crawling
- public/open data
- free APIs/quotas where terms allow
- Google/Bing search-result observation where technically and contractually appropriate
- autocomplete/query expansion sources where permitted
- data generated from the site's own crawl
- historical data Ninja Analytics collects itself
- open-source libraries and MIT/Apache/BSD compatible projects
- locally calculated metrics and transparent heuristics

If a metric cannot be obtained exactly for free, do NOT invent it. Show the best defensible proxy and label it clearly, e.g.:
- "Ninja Difficulty"
- "Observed SERP competition"
- "GSC demand"
- "Estimated opportunity"
- "Tracked rank"
- "Unknown / unavailable"

Never present a locally calculated proxy as Semrush's proprietary metric.

## Existing architecture — preserve it

This repo already has:
- React + TypeScript + Vite frontend
- Tailwind
- TanStack Query
- Recharts
- Supabase Postgres/Auth/Edge Functions/pg_cron
- TOTP MFA / AAL2 admin security
- Google Search Console sync
- GA4 sync
- Bing Webmaster Tools sync
- multi-site portfolio support
- uptime/scheduled sync
- Cloudflare Pages deployment through GitHub Actions

Do not rebuild working foundations.

## Product direction

The target navigation should evolve toward:

- Overview
- Keywords
  - Explorer
  - Opportunities
  - Rankings
  - Gap
  - Clusters
- Competitors
- Pages
- Site Audit
- Backlinks / Links
- AI Visibility
- Reports
- Settings

Use Semrush and GSC Wizard as UX/product references, not code or branding to copy.

## Build priorities

### Phase 1 — Keyword Intelligence from data we already own

Build first because it requires no paid data source.

Create a Keyword Opportunities engine from GSC history.

Automatically detect:

- Strike Now: useful impressions and positions 4–20
- Page 1 opportunities
- Page 2 opportunities
- High impressions / low CTR
- Rising keywords
- Falling keywords
- New queries
- Lost queries
- ranking URL changes
- potential cannibalisation
- wrong-page / intent mismatch signals
- content decay
- branded vs non-branded
- query clusters
- pages gaining/losing query coverage

Every opportunity should explain WHY it exists.

Show:
- query
- page
- clicks
- impressions
- CTR
- current average position
- previous-period position
- position change
- click/impression change
- first seen
- last seen
- trend
- opportunity category
- transparent opportunity score
- recommended action

Do not auto-create thin SEO pages.

### Opportunity score

Use an explainable 0–100 Ninja Opportunity Score.

Use only data actually available.

Possible factors:
- impressions/demand
- current position
- CTR gap
- upward/downward trend
- page/query relevance
- ranking stability
- number of competing internal URLs
- GA4 engagement/conversions where available
- Bing corroboration
- commercial/site relevance if explicitly configured

The UI must expose the factors behind the score.

### Phase 2 — real rank history

GSC average position is not identical to a live SERP rank.

Add tracked-keyword storage and build our own historical tracking where practical without paid APIs.

Requirements:
- saved tracked keywords
- search engine
- country/device/location where realistically supported
- ranking URL
- observed rank
- date
- SERP URL/domain observations
- 1d / 7d / 28d change
- best/worst recorded
- visibility trend

Keep GSC average position and observed rank as separate metrics.

Respect search-engine terms/rate limits. Never create an uncontrolled scraper.

### Phase 3 — Keyword Explorer without paid subscriptions

Keyword Explorer should combine free/owned signals:

- exact GSC query matches
- related GSC queries
- Bing query data
- autocomplete/query suggestions where permitted
- related phrase generation
- question forms
- existing site content/entities
- observed SERP competitors
- historical impressions/clicks
- tracked rank data
- Google Trends if usable through a free lawful mechanism
- optional free Google Ads data only if legitimately available to the owner's account

Return what can be supported:
- keyword/query
- intent classification
- owned-site demand
- trend
- current ranking page
- rank/history
- related queries
- questions
- SERP observations
- competition proxy
- Ninja Difficulty
- Ninja Opportunity
- content mapping

Do NOT invent exact monthly search volume if no legitimate free source provides it.

### Phase 4 — Competitor Discovery and Keyword Gap

Do not wait for a paid competitor database.

Build a bottom-up competitor dataset from our own tracked SERPs:

1. For tracked/important queries, record top ranking domains/pages.
2. Count which domains repeatedly compete with the site.
3. Store competitor observations historically.
4. Discover organic competitors automatically.
5. Compare query coverage from observed SERPs.
6. Build a free "Observed Keyword Gap":
   - competitor observed
   - site observed
   - shared
   - missing from site
   - site stronger
   - competitor stronger

Clearly label it OBSERVED rather than pretending it represents the entire Google keyword universe.

Allow manual competitor domains.

### Phase 5 — Site Audit

Build a proper crawler using open-source libraries and existing NinjaTickets audit logic where useful.

Check at minimum:
- HTTP status
- broken internal links
- redirect chains/loops
- canonical
- indexability
- robots meta
- robots.txt
- sitemap membership
- title presence/duplication/length
- meta descriptions
- H1/H2 structure
- schema/JSON-LD
- internal links
- orphan pages where detectable
- crawl depth
- duplicate/near-duplicate content
- thin pages
- image alt
- oversized images where measurable
- OpenGraph
- pagination
- hreflang if present
- mobile viewport
- structured event data for NinjaTickets-style sites
- link counts
- response/load timings available from crawler

Use free PageSpeed Insights/Core Web Vitals API data only if available under a free quota; cache aggressively.

Give:
- Health Score
- Errors
- Warnings
- Notices
- exact URL
- why it matters
- exact fix suggestion
- first detected
- last detected
- fixed/reopened status

### Phase 6 — On-page SEO checker

For an owned page + target query:
- inspect the page
- compare with observed ranking competitors when available
- headings
- title/meta
- entities/topics
- word/content coverage as a descriptive signal, not a target
- internal links
- schema
- intent
- cannibalisation
- snippet opportunity
- questions/FAQ opportunities

Do not recommend keyword stuffing.

### Phase 7 — Links/backlinks without buying a commercial backlink index

Be realistic.

We cannot reproduce Ahrefs/Semrush's web-scale backlink index for free.

Instead build a useful "Links" product from:
- backlinks visible from free sources legitimately accessible
- known referring traffic from GA4
- Bing/GSC link data if available
- crawled internal links
- manually imported backlink CSVs
- public page/link observations
- newly discovered referring URLs during permitted crawling

Label coverage limitations.

Do not claim exhaustive backlink counts.

### AI Search source coverage

The AI/Search intelligence layer should cover as many major discovery systems as practical, but must distinguish between direct query data and indirect/manual visibility observations.

Explicitly consider:
- ChatGPT / OpenAI search and answer experiences
- Google Gemini / Google AI Mode / AI Overviews
- Microsoft Copilot / Bing AI
- Anthropic Claude
- Apple Siri / Apple Intelligence
- Amazon Alexa
- Yahoo Search / Yahoo AI features where available
- DuckDuckGo / DuckAssist
- Brave Search / Brave Answer with AI
- Ecosia
- Dogpile and other metasearch engines
- Perplexity and other AI answer engines
- any new major AI/search assistants that become materially relevant

For every source, classify capability as one of:
1. Direct first-party query data available
2. Webmaster/analytics visibility data available
3. Public/free API or lawful observation available
4. Manual/on-demand visibility test only
5. No reliable free access

Never imply access to private user prompts or platform-wide query logs when they are not exposed.

The system should normalize all supported sources into common concepts where possible:
- query/prompt text or query cluster
- source/platform
- observed/cited URL
- site mentioned/cited yes/no
- competitor mentioned/cited
- country/device where available
- first seen / last seen
- observation count
- data provenance
- confidence / exact-vs-observed label

Generated prompt opportunities must be clearly labelled as generated, not observed user prompts.

### Phase 8 — AI Search visibility

First use data already available:
- GSC Generative AI features data where exposed
- pages/countries/devices/days
- AI-related search appearance data
- historical changes

Then add optional observed prompt testing only where free APIs/manual testing/allowed automation make it practical.

Never fabricate prompt volume or citation coverage.

## Keyword clustering

Implement locally.

Use:
- lexical similarity
- stems/tokens
- common ranking URL
- query intent
- semantic embeddings only if a free/local method is available

Map clusters to:
- existing best URL
- improve existing URL
- potential new page
- ignore

Prevent cannibalisation.

## Search intent classification

Implement locally with transparent heuristics/classification:
- informational
- navigational
- commercial
- transactional
- local

Allow manual override.

## Ninja Difficulty

Create our own transparent metric, not "Semrush KD".

Possible factors:
- strength/recurrence of ranking domains in observed SERPs
- SERP diversity
- site current rank
- number of strong domains
- exact/partial title match
- result type concentration
- site topical history from GSC
- SERP feature crowding

Display the component factors.

## Ninja Analytics should tell the owner what to do

The Overview should not just display charts.

Add actionable cards such as:
- 12 keywords within reach of page 1
- 7 high-impression pages with weak CTR
- 3 pages losing rankings
- 2 potential cannibalisation problems
- 14 newly discovered queries
- 4 technical errors
- 6 competitor domains repeatedly outranking this site

Each card should link to the underlying evidence.

## Data provenance

Every metric should carry:
- source
- freshness
- exact vs estimated/proxy

Examples:
- GSC · updated 3h ago · exact first-party
- Bing · updated 8h ago · exact first-party
- Observed SERP · 20 Sep 2026 · sampled observation
- Ninja Difficulty · calculated
- Opportunity Score · calculated

Never silently mix first-party facts with estimates.

## Cost and resource control

The software must remain cheap/free to operate.

- Use Supabase pg_cron/Edge Functions or appropriate free scheduling.
- Do not create high-frequency GitHub Actions monitoring.
- GitHub Actions should be for CI/deploy, not permanent data collection.
- Cache results.
- Track only selected keywords frequently.
- Spread work across schedules.
- Incremental crawl rather than full-site crawl every few minutes.
- Record sync duration/errors.
- Add configurable quotas even for free sources.
- Never repeatedly poll deployments.

## Open-source donor projects

It is acceptable to inspect and reuse compatible open-source projects/modules.

Before copying code:
- verify license
- preserve required attribution/license notices
- avoid GPL/AGPL code unless the owner explicitly accepts those obligations
- prefer MIT/Apache/BSD
- transplant small modules rather than replacing this app wholesale

Potential donor categories:
- SEO crawlers
- SERP parsers
- keyword clustering
- technical audit engines
- robots/sitemap parsers
- schema validators

Do not import an entire unknown project just because it says "Semrush alternative".

## Security / ownership

Do not weaken:
- Supabase RLS
- MFA/AAL2 enforcement
- secret handling

Never commit secrets.

The upstream fork owner does not automatically receive access to this fork. Do not add external collaborators or services without owner approval.

## Development discipline

Before a major change:
1. inspect existing implementation
2. reuse current patterns
3. write migration if DB changes
4. add tests
5. run typecheck/build/tests
6. make a coherent commit
7. deploy once
8. check deployment status no more than necessary

Do not waste usage with repeated status polling.

## Definition of success

A user should be able to open Ninja Analytics and answer:

- What should I fix today?
- What keywords am I gaining and losing?
- Which keywords are close to page one?
- Which pages have demand but weak CTR?
- Which pages are decaying?
- What technical problems exist?
- Who repeatedly outranks me?
- What query opportunities are my competitors appearing for?
- Which URL should target each keyword cluster?
- How has my visibility changed?
- What comes from Google/Bing/GA4 versus what Ninja calculated?

without needing a paid Semrush subscription.
