// Site optimisation planning and the guarded apply/rollback path. Pure,
// deterministic code: no AI, no network except through the injected GitHub
// client, so everything here can be tested in isolation.
//
// There is no second Fix engine. Applying a change reuses fix-validation.ts
// (the same evidence and safety gates as the existing Run Fix) and the result
// is handed to the existing fix_runs / advance-fix-runs pipeline for deploy
// verification. This module adds: the mode gate, the allowlist, the safeguard
// checklist (clean baseline, backup, bounded diff, passing checks) and an
// exact-restore rollback.

import {
  validateFixPlan,
  type EvidenceSnapshot,
  type GeneratorControlledEntry,
  type MetaDescriptionFix,
  type RejectedFix,
} from "./fix-validation.ts";

import type { Diagnosis } from "./coverage.ts";
import type { QueryFinding } from "./query-intel.ts";

export type OptimiseMode = "monitor" | "safe_auto" | "approval_required";

export type ChangeClass =
  | "meta_description_refresh"
  | "metadata_fix"
  | "technical_fix"
  | "content_edit"
  | "new_page"
  | "internal_links"
  | "redirect"
  | "deletion"
  | "affiliate_change"
  | "investigate";

/** The only change classes safe auto-fix may ever apply. Everything else is
 * ranking-sensitive or has no safe automated publisher, so it always waits
 * for the owner. */
export const SAFE_AUTO_ALLOWLIST: readonly ChangeClass[] = [
  "meta_description_refresh",
];

/** Sites that have an authorised repository integration, with that repository.
 * A site that is not listed can be analysed but never auto-fixed. */
export const SUPPORTED_PUBLISHERS: Record<
  string,
  { owner: string; repo: string; branch: string; filePath: string }
> = {
  "ninjatickets.com": {
    owner: "looneyhills1-png",
    repo: "ninjatickets",
    branch: "main",
    filePath: "src/data/guides.json",
  },
};

export const SUBSTANTIAL: readonly ChangeClass[] = [
  "content_edit",
  "new_page",
  "redirect",
  "deletion",
  "affiliate_change",
  "internal_links",
  "technical_fix",
];

export function riskOf(c: ChangeClass): "low" | "substantial" {
  return SUBSTANTIAL.includes(c) ? "substantial" : "low";
}

export interface AuditIssueInput {
  url: string | null;
  severity: "error" | "warning" | "notice";
  code: string;
  message: string;
}

export interface OpportunityInput {
  id: string;
  status: string;
  classification: string | null;
  priority: number;
  title: string;
  problem: string;
  recommended_change: string | null;
  proposal: string;
  target_url: string | null;
  change_type: string | null;
  source: string;
}

export interface CtrCandidate {
  query: string;
  url: string;
  currentPosition: number | null;
  impressions: number;
  clicks: number;
}

export interface Hosting {
  platform: string;
  projectId?: string | null;
}

export const PLATFORM_LABEL: Record<string, string> = {
  chatgpt_sites: "ChatGPT Sites",
  github_repo: "a GitHub repository",
  wordpress: "WordPress",
  other: "another platform",
  unknown: "an unrecorded platform",
};

/** Deployment status for a plan item. A site hosted on ChatGPT Sites has no
 * publishing interface that Ninja Analytics (or Claude Code) is authorised to
 * use, so any change is preserved and marked blocked, never worked around. */
export function deploymentFor(
  hosting: Hosting | undefined,
  autoEligible: boolean,
): { deployment: "not_applicable" | "blocked"; note: string | null } {
  if (autoEligible) return { deployment: "not_applicable", note: null };
  if (hosting?.platform === "chatgpt_sites") {
    return {
      deployment: "blocked",
      note: `BLOCKED: this site is hosted on ChatGPT Sites${hosting.projectId ? ` (project ${hosting.projectId})` : ""}. Ninja Analytics has no authorised publishing interface to it, so the change is kept here to be applied in the Sites project. Nothing has been deployed.`,
    };
  }
  return { deployment: "not_applicable", note: null };
}

export interface AssessInput {
  site: { id: string; name: string; domain: string };
  mode: OptimiseMode;
  now: Date;
  audit: {
    finishedAt: string | null;
    pagesCrawled: number;
    healthScore: number | null;
    issues: AuditIssueInput[];
  } | null;
  opportunities: OpportunityInput[];
  ctrCandidates: CtrCandidate[];
  gscThrough: string | null;
  hosting?: Hosting;
  /** Per-URL diagnoses from the coverage inventory + Google inspections. */
  diagnoses?: Diagnosis[];
  /** Findings from the stored Search Console query data. */
  queryFindings?: QueryFinding[];
}

export interface PlanItem {
  key: string;
  title: string;
  problem: string;
  recommendation: string;
  url: string | null;
  changeClass: ChangeClass;
  risk: "low" | "substantial";
  priority: number;
  autoEligible: boolean;
  /** monitor: advice only; needs_approval: waits for the owner; proposed:
   * eligible for the guarded auto path (only in safe_auto mode). */
  status: "proposed" | "needs_approval";
  opportunityId?: string;
  evidence: Record<string, unknown>;
  deployment: "not_applicable" | "blocked";
  deploymentNote: string | null;
}

export interface Assessment {
  health: {
    score: number | null;
    scoreSource: string;
    auditAt: string | null;
    auditAgeDays: number | null;
    searchDataThrough: string | null;
    searchDataAgeDays: number | null;
    stale: string[];
  };
  items: PlanItem[];
  top3: PlanItem[];
  counts: { total: number; autoEligible: number; needsApproval: number };
}

const DAY = 86_400_000;
export const AUDIT_STALE_DAYS = 14;
export const DATA_STALE_DAYS = 4;

const ISSUE_MAP: Record<
  string,
  { changeClass: ChangeClass; what: string; fix: string } | null
> = {
  missing_meta_description: {
    changeClass: "metadata_fix",
    what: "pages with no meta description",
    fix: "Write a short, accurate description (about 50-160 characters) for each page, from facts already on the page.",
  },
  title_length: {
    changeClass: "metadata_fix",
    what: "titles that are too long or too short",
    fix: "Shorten or extend each title to roughly 30-60 characters without changing its meaning.",
  },
  duplicate_title: {
    changeClass: "metadata_fix",
    what: "pages sharing the same title",
    fix: "Give each page a distinct title that says what is unique about it.",
  },
  images_missing_alt: {
    changeClass: "metadata_fix",
    what: "images with no alt text",
    fix: "Add short descriptive alt text to each image.",
  },
  missing_h1: {
    changeClass: "content_edit",
    what: "pages with no main heading",
    fix: "Add one clear H1 that matches the page topic.",
  },
  thin_content: {
    changeClass: "content_edit",
    what: "pages with very little content",
    fix: "Add useful, verified information or merge the page into a stronger one.",
  },
  orphan_page: {
    changeClass: "internal_links",
    what: "pages nothing else links to",
    fix: "Add genuinely relevant links to these pages from related pages.",
  },
  missing_canonical: {
    changeClass: "technical_fix",
    what: "pages with no canonical tag",
    fix: "Add a self-referencing canonical tag.",
  },
  non_self_canonical: {
    changeClass: "technical_fix",
    what: "pages whose canonical points elsewhere",
    fix: "Check each is intentional; otherwise point the canonical at the page itself.",
  },
  no_schema_sitewide: {
    changeClass: "technical_fix",
    what: "no structured data found on the site",
    fix: "Add structured data that matches the content (for example Organization or Article).",
  },
  multiple_h1: {
    changeClass: "content_edit",
    what: "pages with more than one main heading",
    fix: "Keep one H1 for the page topic and make the others H2 or H3.",
  },
  duplicate_meta_description: {
    changeClass: "metadata_fix",
    what: "pages sharing the same meta description",
    fix: "Write a distinct description for each page.",
  },
  duplicate_content: {
    changeClass: "content_edit",
    what: "pages with near-identical content",
    fix: "Merge them, or make each page clearly different in purpose.",
  },
  crawl_budget_reached: null, // a note about the crawl itself, not a site problem
};

function code2(c: string): string {
  return c.toLowerCase();
}

function ageDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).getTime();
  return Number.isNaN(t)
    ? null
    : Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

function issuePriority(sev: AuditIssueInput["severity"], count: number) {
  const base = sev === "error" ? 80 : sev === "warning" ? 55 : 25;
  return Math.min(95, base + Math.min(count, 15));
}

function route(mode: OptimiseMode, eligible: boolean): PlanItem["status"] {
  // monitor: nothing is ever applied, so everything is advice. The status
  // names the next step if the owner later changes the mode.
  if (mode === "safe_auto" && eligible) return "proposed";
  return "needs_approval";
}

export function assessSite(input: AssessInput): Assessment {
  const { site, mode, now, audit } = input;
  const publisher = SUPPORTED_PUBLISHERS[site.domain.replace(/^www\./, "")];
  const raw: Array<Omit<PlanItem, "deployment" | "deploymentNote">> = [];

  // 1. Technical findings from the site's own crawl, grouped by problem.
  const groups = new Map<string, AuditIssueInput[]>();
  for (const i of audit?.issues ?? []) {
    const k = code2(i.code);
    const arr = groups.get(k) ?? [];
    arr.push(i);
    groups.set(k, arr);
  }
  // A page reachable at /page/index.html whose canonical already points at
  // /page/ is a consolidated alias, not a competing duplicate. Search engines
  // are told the clean address, so the real (low-urgency) job is making the
  // site's own links use the clean address. Older audits also reported these
  // as duplicate title / description / content; fold those into one item.
  const aliasUrls = new Map<string, string>();
  for (const i of groups.get("non_self_canonical") ?? []) {
    if (!i.url || !i.url.endsWith("/index.html")) continue;
    const clean = i.url.slice(0, -"index.html".length);
    if (i.message.includes(clean)) aliasUrls.set(i.url, clean);
  }
  if (aliasUrls.size > 0) {
    const involved = new Set<string>([
      ...aliasUrls.keys(),
      ...aliasUrls.values(),
    ]);
    for (const c of [
      "non_self_canonical",
      "duplicate_title",
      "duplicate_meta_description",
      "duplicate_content",
    ]) {
      const rest = (groups.get(c) ?? []).filter(
        (i) => !i.url || !involved.has(i.url),
      );
      if (rest.length) groups.set(c, rest);
      else groups.delete(c);
    }
    raw.push({
      key: "audit:index_html_aliases",
      title: `${aliasUrls.size} pages are also reachable at /page/index.html`,
      problem:
        "Each of these pages loads at both its clean address and an /index.html address. Both already declare the clean address as canonical, so search engines are told which to use. This is low urgency.",
      recommendation:
        "Make the site's own links use the clean addresses (for example /blog/page/ instead of /blog/page/index.html), including related-article links and the blog index. The canonical tags and the sitemap are already correct, so nothing else is needed.",
      url: null,
      changeClass: "internal_links",
      risk: riskOf("internal_links"),
      priority: 40,
      autoEligible: false,
      status: "needs_approval",
      evidence: {
        source: "site audit",
        severity: "notice",
        count: aliasUrls.size,
        canonicalAlreadyCorrect: true,
        examples: [...aliasUrls.keys()].slice(0, 6),
      },
    });
  }

  for (const [code, list] of groups) {
    const known = code in ISSUE_MAP ? ISSUE_MAP[code] : undefined;
    if (known === null) continue;
    const changeClass = known?.changeClass ?? "investigate";
    const sev = list.some((i) => i.severity === "error")
      ? "error"
      : list.some((i) => i.severity === "warning")
        ? "warning"
        : "notice";
    const urls = [
      ...new Set(list.map((i) => i.url).filter(Boolean)),
    ] as string[];
    raw.push({
      key: `audit:${code}`,
      title: `${list.length} ${known?.what ?? code.replace(/_/g, " ")}`,
      problem: list[0].message,
      recommendation:
        known?.fix ?? "Open the Site health report for the affected pages.",
      url: urls.length === 1 ? urls[0] : null,
      changeClass,
      risk: riskOf(changeClass),
      priority: issuePriority(sev, list.length),
      autoEligible: false,
      status: "needs_approval",
      evidence: {
        source: "site audit",
        severity: sev,
        count: list.length,
        urls: urls.slice(0, 8),
      },
    });
  }

  // 2. Validated items already in the Fix queue (never duplicated: they keep
  // their own workflow and history, the plan just points at them).
  for (const o of input.opportunities) {
    if (!["new", "validated", "approved"].includes(o.status)) continue;
    if (
      !["fix_now", "content_improvement", "new_content"].includes(
        o.classification ?? "",
      )
    )
      continue;
    const changeClass: ChangeClass =
      o.classification === "new_content"
        ? "new_page"
        : o.classification === "fix_now"
          ? "technical_fix"
          : "content_edit";
    raw.push({
      key: `opp:${o.id}`,
      title: o.title,
      problem: o.problem,
      recommendation: o.recommended_change ?? o.proposal,
      url: o.target_url,
      changeClass,
      risk: "substantial",
      priority: o.priority,
      autoEligible: false,
      status: "needs_approval",
      opportunityId: o.id,
      evidence: { source: o.source, workflowStatus: o.status },
    });
  }

  // 3. CTR-first meta description refreshes: the one allowlisted, mechanical
  // change. Only offered for sites with an authorised publisher.
  for (const c of input.ctrCandidates) {
    const eligible = Boolean(publisher);
    raw.push({
      key: `ctr:${c.url}:${c.query}`,
      title: `Refresh the meta description for "${c.query}"`,
      problem: `Ranks around position ${c.currentPosition ?? "?"} with ${c.impressions} impressions but ${c.clicks} clicks.`,
      recommendation:
        "Lead the meta description with the exact search query, keeping the existing wording (nothing is invented).",
      url: c.url,
      changeClass: "meta_description_refresh",
      risk: "low",
      priority: Math.min(
        90,
        50 + Math.round(Math.log10(1 + c.impressions) * 12),
      ),
      autoEligible: eligible,
      status: route(mode, eligible),
      evidence: {
        query: c.query,
        url: c.url,
        currentPosition: c.currentPosition,
        impressions: c.impressions,
        clicks: c.clicks,
        ctr: c.impressions > 0 ? c.clicks / c.impressions : null,
        categories: ["high-impression-low-ctr"],
        source: "Google Search Console (28 days)",
      },
    });
  }

  // 4. URL coverage: what Google reports against what the live site does.
  const cov = input.diagnoses ?? [];
  const covGroups: Array<{
    category: Diagnosis["category"];
    only?: (d: Diagnosis) => boolean;
    title: (n: number) => string;
    cls: ChangeClass;
    priority: (inSitemap: boolean) => number;
  }> = [
    {
      category: "not_found",
      title: (n) => `${n} page${n === 1 ? "" : "s"} return 404`,
      cls: "redirect",
      priority: (s) => (s ? 76 : 46),
    },
    {
      category: "blocked",
      title: (n) => `${n} page${n === 1 ? "" : "s"} refused our request`,
      cls: "technical_fix",
      priority: () => 70,
    },
    {
      category: "content",
      title: (n) =>
        `${n} page${n === 1 ? " is" : "s are"} crawled by Google but not indexed`,
      cls: "content_edit",
      priority: () => 66,
    },
    {
      category: "undiscovered",
      title: (n) =>
        `${n} live page${n === 1 ? " is" : "s are"} unknown to Google`,
      cls: "internal_links",
      priority: () => 62,
    },
    {
      category: "waiting",
      title: (n) =>
        `${n} page${n === 1 ? " is" : "s are"} known to Google but not yet crawled`,
      cls: "internal_links",
      priority: () => 50,
    },
    {
      category: "redirect",
      only: (d) => d.evidence.some((e) => e === "Listed in the sitemap"),
      title: (n) =>
        `${n} sitemap entr${n === 1 ? "y" : "ies"} redirect elsewhere`,
      cls: "technical_fix",
      priority: () => 58,
    },
    {
      category: "noindex",
      only: (d) => d.evidence.some((e) => e === "Listed in the sitemap"),
      title: (n) =>
        `${n} sitemap entr${n === 1 ? "y is" : "ies are"} marked noindex`,
      cls: "technical_fix",
      priority: () => 55,
    },
  ];
  for (const g of covGroups) {
    const list = cov.filter(
      (d) => d.category === g.category && (g.only ? g.only(d) : true),
    );
    if (list.length === 0) continue;
    const inSitemap = list.some((d) =>
      d.evidence.includes("Listed in the sitemap"),
    );
    raw.push({
      key: `coverage:${g.category}`,
      title: g.title(list.length),
      problem: list[0].reason,
      recommendation: list[0].action,
      url: list.length === 1 ? list[0].url : null,
      changeClass: g.cls,
      risk: riskOf(g.cls),
      priority: g.priority(inSitemap),
      autoEligible: false,
      status: "needs_approval",
      evidence: {
        source: "Google URL Inspection API + Ninja Analytics' own live check",
        confidence: g.category === "blocked" ? "medium" : "high",
        count: list.length,
        urls: list.slice(0, 10).map((d) => d.url),
        examples: list.slice(0, 3).map((d) => ({
          url: d.url,
          shouldBeIndexed: d.shouldBeIndexed,
          evidence: d.evidence,
        })),
        needsApproval: list.some((d) => d.needsApproval),
      },
    });
  }

  // 5. Query intelligence from stored Search Console data.
  const QCLASS: Record<QueryFinding["kind"], ChangeClass> = {
    losing: "investigate",
    low_ctr: "metadata_fix",
    near_page_one: "content_edit",
    cannibalisation: "content_edit",
    question_gap: "content_edit",
    intent_mismatch: "investigate",
    device_gap: "investigate",
  };
  for (const f of input.queryFindings ?? []) {
    const cls = QCLASS[f.kind];
    raw.push({
      key: `query:${f.key}`,
      title: f.title,
      problem: f.problem,
      recommendation: f.recommendation,
      url: f.url,
      changeClass: cls,
      risk: riskOf(cls),
      priority: f.priority,
      autoEligible: false,
      status: "needs_approval",
      evidence: {
        ...f.evidence,
        confidence: f.confidence,
        findingKind: f.kind,
      },
    });
  }

  const items: PlanItem[] = raw.map((it) => {
    const d = deploymentFor(input.hosting, it.autoEligible);
    return { ...it, deployment: d.deployment, deploymentNote: d.note };
  });
  items.sort((a, b) => b.priority - a.priority);
  // Each item gets exactly one status; recompute for allowlisted ones above.
  const auditAge = ageDays(audit?.finishedAt ?? null, now);
  const dataAge = ageDays(input.gscThrough, now);
  const stale: string[] = [];
  if (!audit) stale.push("No site audit has been run yet.");
  else if (auditAge !== null && auditAge > AUDIT_STALE_DAYS) {
    stale.push(`The last site audit is ${auditAge} days old.`);
  }
  if (dataAge === null) stale.push("No Search Console data yet.");
  else if (dataAge > DATA_STALE_DAYS) {
    stale.push(`Search Console data is ${dataAge} days old.`);
  }

  return {
    health: {
      score: audit?.healthScore ?? null,
      scoreSource: audit
        ? `Site audit of ${audit.pagesCrawled} pages`
        : "No audit yet",
      auditAt: audit?.finishedAt ?? null,
      auditAgeDays: auditAge,
      searchDataThrough: input.gscThrough,
      searchDataAgeDays: dataAge,
      stale,
    },
    items,
    top3: items.slice(0, 3),
    counts: {
      total: items.length,
      autoEligible: items.filter((i) => i.autoEligible).length,
      needsApproval: items.filter((i) => i.status === "needs_approval").length,
    },
  };
}

// ---------------------------------------------------------------------------
// Guarded apply + rollback
// ---------------------------------------------------------------------------

export interface RepoClient {
  getFile(path: string): Promise<{ content: string; sha: string }>;
  putFile(
    path: string,
    content: string,
    previousSha: string,
    message: string,
  ): Promise<{ commitSha: string }>;
}

export interface SafeguardInput {
  mode: OptimiseMode;
  changeClass: ChangeClass;
  autoEligible: boolean;
  changeStatus: string;
  hasPublisher: boolean;
}

/** Every precondition that does not need the repository. Returns the reasons
 * it must refuse; an empty list means it may proceed to the repo checks. */
export function mayAutoApply(s: SafeguardInput): string[] {
  const why: string[] = [];
  if (s.mode !== "safe_auto") {
    why.push(
      `This site is in ${s.mode.replace("_", " ")} mode. Safe auto-fix applies changes only after the owner switches the site to it.`,
    );
  }
  if (!SAFE_AUTO_ALLOWLIST.includes(s.changeClass)) {
    why.push(`"${s.changeClass}" is not on the safe auto-fix allowlist.`);
  }
  if (!s.autoEligible) why.push("This change was not marked eligible.");
  if (!s.hasPublisher) {
    why.push("No authorised repository integration exists for this site.");
  }
  if (s.changeStatus !== "proposed") {
    why.push(`The change is ${s.changeStatus}, not proposed.`);
  }
  return why;
}

export const MAX_CHANGED_LINES = 4;

/** Number of differing lines between two texts of equal structure. */
export function changedLines(a: string, b: string): number {
  const x = a.split("\n");
  const y = b.split("\n");
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

export interface AppliedChange {
  before: { metaDescription: string; fileSha: string; fileContent: string };
  after: { metaDescription: string };
  commitSha: string;
  checks: string[];
}

export type ApplyResult =
  | { ok: true; applied: AppliedChange }
  | { ok: false; reasons: string[]; rejected?: RejectedFix[] };

export interface ApplyInput {
  client: RepoClient;
  filePath: string;
  slug: string;
  evidence: EvidenceSnapshot;
  generatorControlled: GeneratorControlledEntry[];
  commitMessage: string;
}

/** Applies one meta-description refresh with all safeguards:
 *  1. clean baseline  - the file parses and the slug exists exactly once;
 *  2. evidence gates  - the same validateFixPlan as the existing Run Fix;
 *  3. backup          - the full prior file content is returned for storage;
 *  4. bounded diff    - at most MAX_CHANGED_LINES lines change and only the
 *                       target entry's metaDescription;
 *  5. passing checks  - the new file re-parses and re-reads back identically
 *                       apart from that one field;
 *  6. optimistic write - putFile refuses if the file moved underneath us. */
export async function applyMetaDescriptionFix(
  input: ApplyInput,
): Promise<ApplyResult> {
  const file = await input.client.getFile(input.filePath);
  let guides: Array<Record<string, unknown> & { slug: string }>;
  try {
    guides = JSON.parse(file.content);
  } catch {
    return {
      ok: false,
      reasons: ["Baseline is not clean: the file is not valid JSON."],
    };
  }
  const matches = guides.filter((g) => g.slug === input.slug);
  if (!Array.isArray(guides) || matches.length !== 1) {
    return {
      ok: false,
      reasons: [
        `Baseline is not clean: expected exactly one entry for "${input.slug}", found ${matches.length}.`,
      ],
    };
  }
  const index = guides.findIndex((g) => g.slug === input.slug);
  const current =
    typeof guides[index].metaDescription === "string"
      ? (guides[index].metaDescription as string)
      : null;

  const validation = validateFixPlan({
    evidence: input.evidence,
    slug: input.slug,
    currentMetaDescription: current,
    generatorControlled: input.generatorControlled,
  });
  const fix: MetaDescriptionFix | undefined = validation.approved[0];
  if (!fix) {
    return {
      ok: false,
      reasons: ["The evidence and safety checks refused this change."],
      rejected: validation.rejected,
    };
  }

  const next = guides.map((g, i) =>
    i === index ? { ...g, metaDescription: fix.newValue } : g,
  );
  const newContent = JSON.stringify(next, null, 2) + "\n";

  const checks: string[] = ["baseline is valid JSON with one matching entry"];
  const diff = changedLines(file.content, newContent);
  if (diff > MAX_CHANGED_LINES) {
    return {
      ok: false,
      reasons: [
        `The change touches ${diff} lines, more than the ${MAX_CHANGED_LINES}-line limit (the file may use different formatting).`,
      ],
    };
  }
  checks.push(`diff is bounded (${diff} line(s))`);

  const reparsed = JSON.parse(newContent) as Array<Record<string, unknown>>;
  const onlyThatField = reparsed.every((g, i) =>
    i === index
      ? JSON.stringify({ ...g, metaDescription: null }) ===
        JSON.stringify({ ...guides[i], metaDescription: null })
      : JSON.stringify(g) === JSON.stringify(guides[i]),
  );
  if (!onlyThatField || reparsed.length !== guides.length) {
    return {
      ok: false,
      reasons: ["Self-check failed: more than the target field would change."],
    };
  }
  checks.push("only the target metaDescription differs");

  const put = await input.client.putFile(
    input.filePath,
    newContent,
    file.sha,
    input.commitMessage,
  );
  return {
    ok: true,
    applied: {
      before: {
        metaDescription: fix.currentValue,
        fileSha: file.sha,
        fileContent: file.content,
      },
      after: { metaDescription: fix.newValue },
      commitSha: put.commitSha,
      checks,
    },
  };
}

export type RollbackResult =
  | { ok: true; rollbackSha: string }
  | { ok: false; reason: string };

/** Restores the exact backed-up file content. Refuses if the file has changed
 * again since the fix (someone edited it), so it can never clobber later work. */
export async function rollbackMetaDescriptionFix(input: {
  client: RepoClient;
  filePath: string;
  backupContent: string;
  appliedMetaDescription: string;
  slug: string;
  message: string;
}): Promise<RollbackResult> {
  const file = await input.client.getFile(input.filePath);
  // The file must be exactly what the fix produced: the backup with only the
  // target metaDescription changed. Anything else means newer edits exist.
  let expected: string;
  try {
    const backup = JSON.parse(input.backupContent) as Array<
      Record<string, unknown> & { slug: string }
    >;
    expected =
      JSON.stringify(
        backup.map((g) =>
          g.slug === input.slug
            ? { ...g, metaDescription: input.appliedMetaDescription }
            : g,
        ),
        null,
        2,
      ) + "\n";
  } catch {
    return {
      ok: false,
      reason: "The stored backup is not valid JSON; not touching the file.",
    };
  }
  if (file.content !== expected) {
    return {
      ok: false,
      reason:
        "The file has changed since the fix, so an automatic rollback could overwrite newer work. Revert it by hand.",
    };
  }
  const put = await input.client.putFile(
    input.filePath,
    input.backupContent,
    file.sha,
    input.message,
  );
  return { ok: true, rollbackSha: put.commitSha };
}
