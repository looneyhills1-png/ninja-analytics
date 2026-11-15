# Regression inventory (baseline 7540e56)

Built from the repository, not assumptions. Every item below existed before the
one-sweep product completion and is retained; the sidebar was regrouped, not
reduced.

## Screens (src/app/router.tsx)
| Route | Purpose | Sidebar group now |
| --- | --- | --- |
| `/` | Portfolio overview (+ new Top 3 actions) | Overview |
| `/opportunities` | Fix queue: workflow, history, validation | Fixes |
| `/keywords/opportunities` | Keyword opportunities, Fix + Run Fix, Fix runs audit | Fixes |
| `/keywords/ctr-optimizer` | Click-rate (CTR) opportunities | Fixes |
| `/site-audit` | Crawler audit | Fixes |
| `/indexing` | URL Inspection / indexing | Fixes |
| `/keywords` (+ rankings, queries, pages, clusters) | Keyword research and tracking | Research |
| `/competitors` (+ historical-pages, new-lost-pages, links) | Competitor analysis | Research |
| `/content` | NEURONwriter content intelligence | Research |
| `/ai-visibility`, `/ai-readiness` | AI visibility, crawler readiness | AI Visibility |
| `/sites`, `/sites/:id` | Websites, integrations, edit dialog, forecasts, exports | Settings & advanced |
| `/sync-runs`, `/system`, `/settings/security` | Sync history, health/backups/notices, MFA | Settings & advanced |
| `/demo/*`, `/login`, `/mfa/*` | Demo mode, auth | unchanged |

## The Fix workflow (as implemented, preserved untouched)
* **Fix** on each keyword opportunity row opens `FixPromptModal` with the prompt
  from `buildFixPrompt` (`generateFixPrompt.ts`): site, query, ranking URL,
  score factors, competing URLs, diagnosis, CTR evidence, internal links,
  safety rules. Copy only; nothing is edited or published.
* **Run Fix** (`execute-fix` edge function, `fix_runs` table, `advance-fix-runs`)
  is the existing automated path: inspects, validates (`fix-validation.ts`),
  and commits a meta-description change to the ninjatickets repo through the
  GitHub API. It is scoped to NinjaTickets CTR meta-description refreshes and is
  admin+MFA gated. **It was not changed, extended or executed during this work**
  (running it would publish to a live site).
* There is no AI-provider selector or local-model (Ollama/Qwen) feature in the
  repository. `ai-briefing` calls the Anthropic API only if `ANTHROPIC_API_KEY`
  is set; it is unset on the local stack, so no AI spend can occur.

## Added in this sweep
* **Fix** button on every Fix-queue item, using the same modal and a new
  `buildOpportunityFixPrompt` in the same module (no second Fix system). The
  prompt names the real site/URL, evidence, baseline and approval state, and
  forbids publishing until the owner approves.
* Outcome measurement: `build-opportunities` now fills `after_metrics` for
  Implemented/Monitoring items (28-day Search Console window vs baseline,
  verdict via `_shared/outcome.ts`, not judged before 14 days of data).
* Top 3 actions on Overview, grouped navigation.

## Data, jobs, integrations
* Migrations 0001-0025; 11 pg_cron jobs (7 `site-analytics-*`, 4 `ninja-intel-*`).
* Collectors: GSC, GA4, Bing, NEURONwriter, AI referrals, AI readiness.
* Backups to `E:\NinjaAnalytics\backups`; loopback-only access.

## Tests guarding this
`generateFixPrompt.test.ts` (existing keyword Fix), `generateOpportunityFixPrompt.test.ts`,
`ctr-optimizer.test.ts`, `opportunity-workflow.test.ts`, `edge-outcome.test.ts`,
`top-actions.test.ts`, `nav-regression.test.ts`, plus the edge function suites.
