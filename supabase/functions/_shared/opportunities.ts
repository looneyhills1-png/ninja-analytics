// Pure builder for the unified opportunities queue. Every opportunity cites the
// evidence row(s) it came from; nothing is synthesised from thin air. Priority
// is a transparent rule table (kind base + bounded evidence bump), not a score
// claiming to measure real-world outcomes. Expected impact is always an
// estimate and says so.

import type { Finding } from "./ai-readiness.ts";

export type OppSource =
  | "gsc"
  | "bing"
  | "ga4"
  | "neuronwriter"
  | "ai_readiness"
  | "ai_visibility";

export interface Opportunity {
  siteId: string;
  dedupeKey: string;
  source: OppSource;
  kind: string;
  targetUrl: string | null;
  title: string;
  problem: string;
  evidence: Record<string, unknown>;
  evidenceAt: string;
  proposal: string;
  expectedImpact: string;
  effort: "low" | "medium" | "high";
  priority: number;
  requiresPublishApproval: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// -- Readiness findings ------------------------------------------------------

interface ReadinessRule {
  base: number;
  kind: string;
  title: string;
  proposal: string;
  impact: string;
  effort: "low" | "medium" | "high";
  publish: boolean;
}

const READINESS_RULES: Array<{ match: RegExp; rule: ReadinessRule }> = [
  {
    match: /^crawler_(googlebot|bingbot)$/,
    rule: {
      base: 98,
      kind: "crawler_blocked",
      title: "A major search crawler is blocked by robots.txt",
      proposal:
        "Remove the Disallow rule that matches this crawler in robots.txt.",
      impact:
        "Estimate: restores any search visibility; the whole site is invisible to this engine while blocked.",
      effort: "low",
      publish: true,
    },
  },
  {
    match:
      /^crawler_(oai-searchbot|chatgpt-user|perplexitybot|claude-searchbot)$/,
    rule: {
      base: 70,
      kind: "ai_crawler_blocked",
      title: "An AI search crawler is blocked by robots.txt",
      proposal:
        "If you want to be citable in this assistant, allow this crawler in robots.txt.",
      impact:
        "Estimate: makes pages eligible for citation by this assistant; no volume is implied.",
      effort: "low",
      publish: true,
    },
  },
  {
    match: /^(noindex_meta|noindex_header)$/,
    rule: {
      base: 92,
      kind: "noindex",
      title: "Pages carry a noindex directive",
      proposal:
        "Confirm each page should be excluded; otherwise remove the noindex directive.",
      impact:
        "Estimate: indexable pages regain eligibility to appear in search.",
      effort: "low",
      publish: true,
    },
  },
  {
    match: /^(page_http_error|page_unreachable)$/,
    rule: {
      base: 88,
      kind: "http_error",
      title: "Pages return errors or cannot be fetched",
      proposal: "Fix or redirect the failing URLs, or remove links to them.",
      impact: "Estimate: avoids lost crawls and broken visits.",
      effort: "medium",
      publish: true,
    },
  },
  {
    match: /^structured_data_invalid$/,
    rule: {
      base: 72,
      kind: "structured_data_invalid",
      title: "Structured data is not valid JSON",
      proposal: "Repair the JSON-LD blocks so parsers can read them.",
      impact:
        "Estimate: restores rich-result and entity eligibility on these pages.",
      effort: "low",
      publish: true,
    },
  },
  {
    match: /^(canonical_offsite|canonical_invalid)$/,
    rule: {
      base: 66,
      kind: "canonical_problem",
      title: "Canonical URL points off-site or is invalid",
      proposal: "Point the canonical at the page's own preferred URL.",
      impact: "Estimate: consolidates ranking signals on the intended URL.",
      effort: "low",
      publish: true,
    },
  },
  {
    match: /^redirect_chain$/,
    rule: {
      base: 52,
      kind: "redirect_chain",
      title: "Redirect chains slow crawling",
      proposal: "Link or redirect straight to the final URL.",
      impact: "Estimate: small crawl-efficiency gain.",
      effort: "low",
      publish: true,
    },
  },
  {
    match: /^duplicate_content$/,
    rule: {
      base: 58,
      kind: "duplicate_content",
      title: "Pages share identical body text",
      proposal: "Consolidate with a canonical or differentiate the pages.",
      impact: "Estimate: reduces cannibalisation between the duplicates.",
      effort: "medium",
      publish: true,
    },
  },
  {
    match: /^(canonical_missing|title_missing|h1_missing)$/,
    rule: {
      base: 48,
      kind: "on_page_basics",
      title: "Basic on-page elements are missing",
      proposal: "Add the missing canonical, title or H1.",
      impact: "Estimate: clearer page signals for search and assistants.",
      effort: "low",
      publish: true,
    },
  },
  {
    match: /^thin_content$/,
    rule: {
      base: 36,
      kind: "thin_content",
      title: "Pages have very little body text",
      proposal:
        "Expand with genuinely useful content or consolidate the pages.",
      impact: "Estimate: only helps where the page targets real demand.",
      effort: "high",
      publish: true,
    },
  },
  {
    match: /^no_answer_headings$/,
    rule: {
      base: 30,
      kind: "answer_structure",
      title: "No answer-style headings",
      proposal:
        "Where users ask questions, add a clear question heading with a direct answer beneath it.",
      impact: "Estimate: may improve snippet and assistant answer eligibility.",
      effort: "medium",
      publish: true,
    },
  },
];

/** Groups warning/error readiness findings by (site, rule) so one opportunity
 * covers all affected URLs. Findings with severity ok/notice are ignored,
 * except where the rule explicitly targets a notice kind. */
export function opportunitiesFromReadiness(
  siteId: string,
  findings: Array<Finding & { checkedAt: string }>,
): Opportunity[] {
  const groups = new Map<
    string,
    { rule: ReadinessRule; items: Array<Finding & { checkedAt: string }> }
  >();
  for (const f of findings) {
    if (f.severity === "ok") continue;
    const hit = READINESS_RULES.find((r) => r.match.test(f.checkKey));
    if (!hit) continue;
    // Training-bot blocks are an owner choice, never an opportunity.
    if (f.checkKey.startsWith("crawler_") && f.severity !== "error") continue;
    const key = /^crawler_/.test(f.checkKey) ? f.checkKey : hit.rule.kind;
    const g = groups.get(key) ?? { rule: hit.rule, items: [] };
    g.items.push(f);
    groups.set(key, g);
  }

  const out: Opportunity[] = [];
  for (const [key, { rule, items }] of groups) {
    const urls = [
      ...new Set(items.map((i) => i.url).filter(Boolean)),
    ] as string[];
    const latest = items
      .map((i) => i.checkedAt)
      .sort()
      .at(-1)!;
    const bump = Math.min(8, Math.floor(Math.log2(items.length + 1) * 2));
    out.push({
      siteId,
      dedupeKey: `readiness:${key}`,
      source: "ai_readiness",
      kind: rule.kind,
      targetUrl: urls.length === 1 ? urls[0] : null,
      title: rule.title,
      problem: `${items.length} finding(s): ${items[0].message}`,
      evidence: {
        checkKey: items[0].checkKey,
        count: items.length,
        sampleUrls: urls.slice(0, 5),
      },
      evidenceAt: latest,
      proposal: rule.proposal,
      expectedImpact: rule.impact,
      effort: rule.effort,
      priority: clamp(rule.base + bump),
      requiresPublishApproval: rule.publish,
    });
  }
  return out;
}

// -- Indexing failures (Google URL Inspection, first-party) -------------------

export interface InspectionRow {
  url: string;
  verdict: string | null;
  coverageState: string | null;
  lastInspectedAt: string;
}

export function opportunitiesFromInspections(
  siteId: string,
  rows: InspectionRow[],
): Opportunity[] {
  // A deliberate noindex is reported as NEUTRAL "Excluded by 'noindex' tag"; it
  // is only a failure if the page is supposed to rank, which we cannot know.
  // FAIL verdicts and "crawled/discovered - not indexed" are genuine failures.
  const failing = rows.filter(
    (r) =>
      r.verdict === "FAIL" ||
      /crawled.*not indexed|discovered.*not indexed/i.test(
        r.coverageState ?? "",
      ),
  );
  return failing.map((r) => ({
    siteId,
    dedupeKey: `indexing:${r.url}`,
    source: "gsc" as const,
    kind: "indexing_failure",
    targetUrl: r.url,
    title: "Google reports this URL is not indexed",
    problem: `URL Inspection: ${r.coverageState ?? r.verdict ?? "unknown state"}.`,
    evidence: { verdict: r.verdict, coverageState: r.coverageState },
    evidenceAt: r.lastInspectedAt,
    proposal:
      "Check the page is useful, linked internally and in the sitemap, then request re-inspection.",
    expectedImpact:
      "Estimate: the page cannot appear in Google results until indexed.",
    effort: "medium",
    priority: 90,
    requiresPublishApproval: true,
  }));
}

// -- Declining pages (GSC clicks, 28d vs previous 28d) ------------------------

export interface PageTrend {
  page: string;
  clicksRecent: number;
  clicksPrevious: number;
  dataThrough: string;
}

export function opportunitiesFromDecline(
  siteId: string,
  trends: PageTrend[],
): Opportunity[] {
  const out: Opportunity[] = [];
  for (const t of trends) {
    if (t.clicksPrevious < 20) continue; // too little data to call a trend
    const drop = (t.clicksPrevious - t.clicksRecent) / t.clicksPrevious;
    if (drop < 0.3) continue;
    out.push({
      siteId,
      dedupeKey: `decline:${t.page}`,
      source: "gsc",
      kind: "declining_page",
      targetUrl: t.page,
      title: "Search clicks to this page are falling",
      problem: `Clicks fell ${Math.round(drop * 100)}% (${t.clicksPrevious} → ${t.clicksRecent}) comparing the last 28 days with the 28 before.`,
      evidence: {
        clicksRecent: t.clicksRecent,
        clicksPrevious: t.clicksPrevious,
        dropPct: Math.round(drop * 100),
      },
      evidenceAt: t.dataThrough,
      proposal:
        "Review the page against current top results, refresh outdated content and check for lost internal links.",
      expectedImpact:
        "Estimate: recovering part of the lost clicks; actual outcome depends on cause.",
      effort: "medium",
      priority: clamp(45 + drop * 40 + Math.min(10, t.clicksPrevious / 50)),
      requiresPublishApproval: true,
    });
  }
  return out;
}

// -- NEURONwriter analyses ----------------------------------------------------

export interface NeuronAnalysisRow {
  neuronQueryId: string;
  keyword: string;
  status: string;
  questions: string[];
  fetchedAt: string;
}

export function opportunitiesFromNeuron(
  siteId: string,
  analyses: NeuronAnalysisRow[],
): Opportunity[] {
  return analyses
    .filter((a) => a.status === "ready" && a.questions.length > 0)
    .map((a) => ({
      siteId,
      dedupeKey: `neuron:${a.neuronQueryId}`,
      source: "neuronwriter" as const,
      kind: "unanswered_questions",
      targetUrl: null,
      title: `Questions to cover for “${a.keyword}”`,
      problem: `NEURONwriter surfaced ${a.questions.length} related question(s). Whether the page already answers them has not been checked.`,
      evidence: { keyword: a.keyword, questions: a.questions.slice(0, 8) },
      evidenceAt: a.fetchedAt,
      proposal:
        "Compare these questions with the target page and add direct answers where the page is silent.",
      expectedImpact:
        "Estimate: broader topical coverage; no traffic figure is implied.",
      effort: "medium",
      priority: clamp(34 + Math.min(10, a.questions.length)),
      requiresPublishApproval: true,
    }));
}
