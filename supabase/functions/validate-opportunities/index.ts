// validate-opportunities: reviews queue items against the real pages and
// first-party demand. Deterministic rules only (no AI, no paid APIs).
//
// Bounds: our own hosts only, at most MAX_PAGES page fetches per run with a
// politeness delay, sitemap discovery capped, a global time budget. Original
// opportunity fields (title, problem, evidence) are never rewritten; every
// verdict is appended to opportunity_reviews and status changes go through the
// workflow trigger, which records them in opportunity_events.

import { fetchWithRetry } from "../_shared/http.ts";
import {
  extractPageData,
  parseSitemapLocs,
  isLikelySitemapIndex,
} from "../_shared/site-crawler.ts";
import { isOwnedUrl } from "../_shared/ai-readiness.ts";
import {
  entityTokens,
  markDuplicates,
  matchPage,
  analyseQuestions,
  duplicateVerdict,
  candidatePages,
  coverageOfQuestion,
  stripBoilerplate,
  reviewAnswerStructure,
  reviewDecline,
  reviewKeyword,
  reviewQuestionSet,
  RULES_VERSION,
  type Demand,
  type PageFacts,
  type Verdict,
  type Window,
} from "../_shared/opportunity-validation.ts";
import { fetchAllRows, serveIntel } from "../_shared/intel-common.ts";

const MAX_PAGES = 80;
const MAX_SITEMAPS_PER_SITE = 8;
const POLITE_DELAY_MS = 600;
const TIME_BUDGET_MS = 110_000;
const UA = "ninja-analytics-validation/1.0 (owner self-audit)";
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// Priority base by site, following the owner's order: Canned Cooking, then
// WW3Supply preparedness, then NinjaTickets commercial opportunities.
const SITE_BASE: Record<string, number> = {
  "cannedcooking.com": 70,
  "ww3supply.com": 65,
  "ninjatickets.com": 55,
};

const QUESTION_KEYWORD =
  /^(how|what|why|when|where|who|which|can|should|do|does|is|are|will)\b/i;

const TECHNICAL_KINDS = new Set([
  "crawler_blocked",
  "ai_crawler_blocked",
  "noindex",
  "http_error",
  "indexing_failure",
  "structured_data_invalid",
  "canonical_problem",
]);

interface SiteRow {
  id: string;
  domain: string;
  website_url: string;
}

serveIntel(async ({ admin, trigger }) => {
  const started = Date.now();
  let pagesFetched = 0;

  const { data: sitesData, error: sitesErr } = await admin
    .from("sites")
    .select("id, domain, website_url")
    .eq("is_active", true);
  if (sitesErr) throw sitesErr;
  const sites = (sitesData ?? []) as SiteRow[];

  const sitemapCache = new Map<string, string[]>();
  async function sitemapUrls(site: SiteRow): Promise<string[]> {
    const cached = sitemapCache.get(site.id);
    if (cached) return cached;
    const out: string[] = [];
    try {
      const origin = new URL(site.website_url || `https://${site.domain}`)
        .origin;
      const queue: string[] = [];
      try {
        const r = await fetchWithRetry(
          `${origin}/robots.txt`,
          { headers: { "User-Agent": UA } },
          { timeoutMs: 8_000, maxRetries: 1 },
        );
        if (r.ok) {
          for (const m of (await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim))
            queue.push(m[1]);
        } else await r.body?.cancel();
      } catch {
        /* fall back below */
      }
      if (queue.length === 0) queue.push(`${origin}/sitemap.xml`);
      let fetched = 0;
      while (
        queue.length &&
        fetched < MAX_SITEMAPS_PER_SITE &&
        Date.now() - started < TIME_BUDGET_MS
      ) {
        const sm = queue.shift()!;
        if (!isOwnedUrl(sm, site.domain)) continue;
        fetched += 1;
        await sleep(POLITE_DELAY_MS);
        try {
          const r = await fetchWithRetry(
            sm,
            { headers: { "User-Agent": UA } },
            { timeoutMs: 10_000, maxRetries: 1 },
          );
          if (!r.ok) {
            await r.body?.cancel();
            continue;
          }
          const xml = await r.text();
          const locs = parseSitemapLocs(xml).filter((u) =>
            isOwnedUrl(u, site.domain),
          );
          if (isLikelySitemapIndex(xml)) queue.push(...locs);
          else out.push(...locs);
        } catch {
          /* skip this sitemap */
        }
      }
    } catch {
      /* leave empty */
    }
    sitemapCache.set(site.id, out);
    return out;
  }

  const pageCache = new Map<string, PageFacts | null>();
  async function pageFacts(
    url: string,
    domain: string,
  ): Promise<PageFacts | null> {
    if (pageCache.has(url)) return pageCache.get(url)!;
    if (!isOwnedUrl(url, domain)) return null;
    if (pagesFetched >= MAX_PAGES || Date.now() - started > TIME_BUDGET_MS)
      return null;
    pagesFetched += 1;
    await sleep(POLITE_DELAY_MS);
    let facts: PageFacts;
    try {
      const res = await fetchWithRetry(
        url,
        { headers: { "User-Agent": UA } },
        { timeoutMs: 10_000, maxRetries: 1 },
      );
      const status = res.status;
      const header = res.headers.get("x-robots-tag") ?? "";
      if (
        status >= 400 ||
        !/html/i.test(res.headers.get("content-type") ?? "")
      ) {
        await res.body?.cancel();
        facts = {
          url,
          status,
          noindex: false,
          canonicalOffsite: false,
          words: 0,
          text: "",
        };
      } else {
        const html = (await res.text()).slice(0, 1_500_000);
        const d = extractPageData(html, res.url || url);
        let canonicalOffsite = false;
        if (d.canonicalUrl) {
          try {
            canonicalOffsite = !isOwnedUrl(
              new URL(d.canonicalUrl, url).href,
              domain,
            );
          } catch {
            canonicalOffsite = false;
          }
        }
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(
            /<\/(p|li|h[1-6]|div|section|article|tr|td|dd|dt|summary|details|a)>|<br\s*\/?>/gi,
            "\n",
          )
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;|&amp;/g, " ")
          .replace(/[ \t]+/g, " ")
          .replace(/\n\s*\n+/g, "\n")
          .slice(0, 200_000);
        facts = {
          url,
          status,
          noindex: d.metaRobotsNoindex || /noindex/i.test(header),
          canonicalOffsite,
          words: d.wordCount,
          text,
        };
      }
    } catch {
      facts = {
        url,
        status: null,
        noindex: false,
        canonicalOffsite: false,
        words: 0,
        text: "",
      };
    }
    pageCache.set(url, facts);
    return facts;
  }

  async function demandFor(siteId: string, keyword: string): Promise<Demand> {
    const toks = entityTokens(keyword).slice(0, 4);
    const demand: Demand = {
      googleImpressions: 0,
      googleClicks: 0,
      bingImpressions: 0,
      bingClicks: 0,
    };
    if (toks.length === 0) return demand;
    const data = await fetchAllRows<{
      engine: string;
      impressions: number;
      clicks: number;
    }>((from, to) => {
      let q = admin
        .from("search_query_daily")
        .select("engine, impressions, clicks")
        .eq("site_id", siteId);
      for (const t of toks) q = q.ilike("query", `%${t}%`);
      return q.order("metric_date").order("query").range(from, to);
    });
    for (const r of data) {
      if (r.engine === "google") {
        demand.googleImpressions += Number(r.impressions);
        demand.googleClicks += Number(r.clicks);
      } else if (r.engine === "bing") {
        demand.bingImpressions += Number(r.impressions);
        demand.bingClicks += Number(r.clicks);
      }
    }
    return demand;
  }

  async function pageWindows(
    siteId: string,
    url: string,
  ): Promise<{ recent: Window; previous: Window; through: string } | null> {
    const { data: last } = await admin
      .from("search_page_daily")
      .select("metric_date")
      .eq("site_id", siteId)
      .eq("engine", "google")
      .order("metric_date", { ascending: false })
      .limit(1);
    const through = last?.[0]?.metric_date as string | undefined;
    if (!through) return null;
    const end = new Date(`${through}T00:00:00Z`);
    const midStart = isoDate(new Date(end.getTime() - 27 * DAY));
    const prevStart = isoDate(new Date(end.getTime() - 55 * DAY));
    const { data } = await admin
      .from("search_page_daily")
      .select("metric_date, clicks, impressions, average_position")
      .eq("site_id", siteId)
      .eq("engine", "google")
      .eq("page", url)
      .gte("metric_date", prevStart)
      .lte("metric_date", through)
      .limit(500);
    const acc = (): Window & { w: number } => ({
      clicks: 0,
      impressions: 0,
      position: null,
      w: 0,
    });
    const recent = acc();
    const previous = acc();
    for (const r of data ?? []) {
      const t = r.metric_date >= midStart ? recent : previous;
      const imp = Number(r.impressions);
      t.clicks += Number(r.clicks);
      t.impressions += imp;
      if (r.average_position != null && imp > 0) {
        t.position = (t.position ?? 0) + Number(r.average_position) * imp;
        t.w += imp;
      }
    }
    const fin = (a: Window & { w: number }): Window => ({
      clicks: a.clicks,
      impressions: a.impressions,
      position:
        a.w > 0 && a.position !== null
          ? Math.round((a.position / a.w) * 10) / 10
          : null,
    });
    return { recent: fin(recent), previous: fin(previous), through };
  }

  // ---- load work ------------------------------------------------------------
  const { data: oppsData, error: oppsErr } = await admin
    .from("opportunities")
    .select(
      "id, site_id, kind, source, dedupe_key, target_url, status, priority, original_priority, evidence, baseline, classification",
    )
    .in("status", ["new", "validated", "monitoring", "rejected"]);
  if (oppsErr) throw oppsErr;
  // Items the owner rejected stay rejected; only rejections made by this
  // validator (actor "system") are re-reviewed, so improved rules can correct
  // an earlier automated verdict.
  const rejectedIds = (oppsData ?? [])
    .filter((o) => o.status === "rejected")
    .map((o) => o.id as string);
  const ownerRejected = new Set<string>();
  if (rejectedIds.length) {
    const { data: evs } = await admin
      .from("opportunity_events")
      .select("opportunity_id, actor, at")
      .in("opportunity_id", rejectedIds)
      .eq("to_status", "rejected")
      .order("at", { ascending: false });
    const seen = new Set<string>();
    for (const e of evs ?? []) {
      if (seen.has(e.opportunity_id)) continue;
      seen.add(e.opportunity_id);
      if (e.actor !== "system") ownerRejected.add(e.opportunity_id);
    }
  }
  const opps = (oppsData ?? []).filter((o) => !ownerRejected.has(o.id));

  // Pre-compute keyword work so duplicates can be resolved per page.
  interface KeywordWork {
    id: string;
    siteId: string;
    domain: string;
    keyword: string;
    questions: string[];
    matchUrl: string | null;
    matchScore: number;
    demand: Demand;
    intents: number;
    isQuestion: boolean;
    candidates: string[];
  }
  const keywordWork: KeywordWork[] = [];
  for (const o of opps) {
    if (o.kind !== "unanswered_questions") continue;
    const site = sites.find((s) => s.id === o.site_id);
    if (!site) continue;
    const analysisId = String(o.dedupe_key).replace(/^neuron:/, "");
    const { data: a } = await admin
      .from("neuron_analyses")
      .select("keyword, questions")
      .eq("neuron_query_id", analysisId)
      .maybeSingle();
    if (!a) continue;
    const questions = (a.questions as string[]) ?? [];
    const urls = await sitemapUrls(site);
    const isQuestion = QUESTION_KEYWORD.test(a.keyword);
    const m = isQuestion ? null : matchPage(a.keyword, urls, "/guides/");
    keywordWork.push({
      id: o.id,
      siteId: o.site_id,
      domain: site.domain,
      keyword: a.keyword,
      questions,
      matchUrl: m?.url ?? null,
      matchScore: m?.score ?? 0,
      demand: await demandFor(o.site_id, a.keyword),
      intents: analyseQuestions(questions, a.keyword).intents.length,
      isQuestion,
      candidates: isQuestion ? candidatePages(a.keyword, urls, 4) : [],
    });
  }

  // Prefetch every page we will judge, strip site-wide boilerplate so a
  // repeated blurb cannot count as an answer, then pick the best page for
  // question-style keywords by what the page actually says.
  const wanted = new Map<string, SiteRow>();
  for (const k of keywordWork) {
    const site = sites.find((x) => x.id === k.siteId)!;
    for (const u of [k.matchUrl, ...k.candidates]) if (u) wanted.set(u, site);
  }
  for (const o of opps) {
    if (o.kind === "declining_page" && o.target_url) {
      wanted.set(o.target_url, sites.find((x) => x.id === o.site_id)!);
    }
  }
  for (const [u, site] of wanted) await pageFacts(u, site.domain);
  for (const site of sites) {
    const own = [...wanted]
      .filter(([, st]) => st.id === site.id)
      .map(([u]) => pageCache.get(u))
      .filter((p): p is PageFacts => !!p && p.text.length > 0);
    const cleaned = stripBoilerplate(own.map((p) => p.text));
    own.forEach((p, i) => {
      p.text = cleaned[i];
    });
  }
  for (const k of keywordWork) {
    if (!k.isQuestion) continue;
    let best: { url: string; cov: number } | null = null;
    for (const u of k.candidates) {
      const p = pageCache.get(u);
      if (!p || (p.status ?? 0) >= 400 || !p.text) continue;
      const cov = coverageOfQuestion(k.keyword, p.text);
      if (!best || cov > best.cov) best = { url: u, cov };
    }
    if (best && best.cov >= 0.5) {
      k.matchUrl = best.url;
      k.matchScore = Math.round(best.cov * 100) / 100;
    }
  }
  const dupOf = markDuplicates(
    keywordWork.map((k) => ({
      id: k.id,
      keyword: k.keyword,
      matchUrl: k.matchUrl,
      demand: k.demand.googleImpressions + k.demand.bingImpressions,
      intents: k.intents,
      questions: k.questions,
    })),
  );

  const verdicts: Array<{
    id: string;
    title: string;
    site: string;
    v: Verdict;
    matchUrl: string | null;
  }> = [];
  const skipped: string[] = [];

  for (const o of opps) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped.push(o.id);
      continue;
    }
    const site = sites.find((s) => s.id === o.site_id);
    if (!site) continue;
    const base = SITE_BASE[site.domain] ?? 50;
    let v: Verdict | null = null;
    let matchUrl: string | null = null;

    if (o.kind === "unanswered_questions") {
      const k = keywordWork.find((w) => w.id === o.id);
      if (!k) continue;
      matchUrl = k.matchUrl;
      const page = k.matchUrl ? await pageFacts(k.matchUrl, site.domain) : null;
      const match = k.matchUrl
        ? { url: k.matchUrl, score: k.matchScore }
        : null;
      const keptKeyword = dupOf.get(o.id) ?? null;
      v = keptKeyword
        ? duplicateVerdict(k.keyword, keptKeyword, { matchedUrl: k.matchUrl })
        : QUESTION_KEYWORD.test(k.keyword)
          ? reviewQuestionSet({
              keyword: k.keyword,
              questions: k.questions,
              match,
              page,
              siteBase: base,
              siteLabel: site.domain,
            })
          : reviewKeyword({
              keyword: k.keyword,
              questions: k.questions,
              match,
              page,
              demand: k.demand,
              duplicateOfKeyword: dupOf.get(o.id) ?? null,
              siteBase: base,
            });
    } else if (o.kind === "declining_page" && o.target_url) {
      matchUrl = o.target_url;
      const w = await pageWindows(o.site_id, o.target_url);
      if (!w) continue;
      v = reviewDecline({
        url: o.target_url,
        recent: w.recent,
        previous: w.previous,
        page: await pageFacts(o.target_url, site.domain),
        siteBase: base,
      });
    } else if (o.kind === "answer_structure") {
      const { data: run } = await admin
        .from("ai_readiness_runs")
        .select("id")
        .eq("site_id", o.site_id)
        .in("status", ["success", "partial"])
        .order("started_at", { ascending: false })
        .limit(1);
      const { data: f } = run?.[0]
        ? await admin
            .from("ai_readiness_findings")
            .select("url")
            .eq("run_id", run[0].id)
            .eq("check_key", "no_answer_headings")
        : { data: [] as Array<{ url: string | null }> };
      v = reviewAnswerStructure(
        (f ?? []).map((r) => r.url).filter((u): u is string => !!u),
      );
      const qrows = await fetchAllRows<{
        query: string;
        impressions: number;
        clicks: number;
      }>((from, to) =>
        admin
          .from("search_query_daily")
          .select("query, impressions, clicks")
          .eq("site_id", o.site_id)
          .order("metric_date")
          .order("query")
          .range(from, to),
      );
      const byQuery = new Map<
        string,
        { impressions: number; clicks: number }
      >();
      for (const r of qrows) {
        const cur = byQuery.get(r.query) ?? { impressions: 0, clicks: 0 };
        cur.impressions += Number(r.impressions);
        cur.clicks += Number(r.clicks);
        byQuery.set(r.query, cur);
      }
      v.evidence = {
        ...v.evidence,
        siteSearchQueries: {
          distinctQueries: byQuery.size,
          top: [...byQuery]
            .sort((a, b) => b[1].impressions - a[1].impressions)
            .slice(0, 8)
            .map(([query, m]) => ({ query, ...m })),
        },
      };
    } else if (TECHNICAL_KINDS.has(o.kind)) {
      v = {
        classification: "fix_now",
        reasoning:
          "First-party evidence of a technical failure (see the original evidence).",
        recommendedChange: null,
        changeType: "technical",
        priority: Math.max(Number(o.priority), 90),
        evidence: { kind: o.kind },
      };
    } else {
      v = {
        classification: "monitor",
        reasoning: "No validation rule exists for this opportunity type yet.",
        recommendedChange: null,
        changeType: null,
        priority: Number(o.priority),
        evidence: { kind: o.kind },
      };
    }
    verdicts.push({
      id: o.id,
      title: String(o.evidence?.keyword ?? o.kind),
      site: site.domain,
      v,
      matchUrl,
    });
  }

  // ---- persist --------------------------------------------------------------
  const counts: Record<string, number> = {};
  let reviewsWritten = 0;
  let statusChanges = 0;
  const nowIso = new Date().toISOString();
  for (const { id, site, v, matchUrl } of verdicts) {
    counts[v.classification] = (counts[v.classification] ?? 0) + 1;
    const opp = opps.find((o) => o.id === id)!;

    // Baseline: the target page's own first-party numbers before any change.
    let baseline = opp.baseline ?? null;
    const baselineUrl = matchUrl ?? opp.target_url;
    if (!baseline && baselineUrl) {
      const w = await pageWindows(opp.site_id, baselineUrl);
      if (w) {
        baseline = {
          capturedAt: nowIso,
          source: "gsc",
          window: "last 28 days of data",
          dataThrough: w.through,
          url: baselineUrl,
          ...w.recent,
        };
      }
    }

    // Append-only audit row, skipped if identical to the latest review.
    const { data: prev } = await admin
      .from("opportunity_reviews")
      .select("classification, reasoning")
      .eq("opportunity_id", id)
      .order("reviewed_at", { ascending: false })
      .limit(1);
    const same =
      prev?.[0]?.classification === v.classification &&
      prev?.[0]?.reasoning === v.reasoning;
    if (!same) {
      const { error } = await admin.from("opportunity_reviews").insert({
        opportunity_id: id,
        rules_version: RULES_VERSION,
        classification: v.classification,
        reasoning: v.reasoning,
        evidence: {
          ...v.evidence,
          originalPriority: opp.original_priority ?? opp.priority,
        },
      });
      if (error) throw error;
      reviewsWritten += 1;
    }

    const target =
      v.classification === "reject"
        ? "rejected"
        : v.classification === "monitor"
          ? "monitoring"
          : "validated";
    let currentStatus = opp.status as string;
    if (currentStatus === "rejected" && target !== "rejected") {
      // The workflow only allows Rejected -> New; reopen, then classify.
      const { error: reopenErr } = await admin
        .from("opportunities")
        .update({
          status: "new",
          status_note: `Validator ${RULES_VERSION}: re-reviewed after a rule correction`,
        })
        .eq("id", id);
      if (reopenErr) throw reopenErr;
      currentStatus = "new";
    }
    const nextStatus = currentStatus === target ? currentStatus : target;
    const { error: upErr } = await admin
      .from("opportunities")
      .update({
        classification: v.classification,
        recommended_change: v.recommendedChange,
        change_type: v.changeType,
        priority: v.priority,
        baseline,
        reviewed_at: nowIso,
        status: nextStatus,
        status_note:
          nextStatus !== currentStatus
            ? `Validator ${RULES_VERSION}: ${v.classification}. ${v.reasoning}`.slice(
                0,
                600,
              )
            : null,
      })
      .eq("id", id);
    if (upErr) throw upErr;
    if (nextStatus !== opp.status) statusChanges += 1;
    void site;
  }

  return {
    trigger,
    rulesVersion: RULES_VERSION,
    reviewed: verdicts.length,
    reviewsWritten,
    statusChanges,
    pagesFetched,
    skippedForTimeBudget: skipped.length,
    byClassification: counts,
    summary: verdicts.map((x) => ({
      site: x.site,
      title: x.title,
      classification: x.v.classification,
      priority: x.v.priority,
    })),
  };
});
