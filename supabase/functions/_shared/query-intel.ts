// Query intelligence from the Search Console data already stored locally.
// Pure and deterministic: no AI, no network. Every finding carries its own
// evidence and a confidence level, and nothing here invents a search volume or
// a competitor ranking: only impressions, clicks and positions that Search
// Console actually reported for this site.

export interface QPRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  /** impression-weighted average position */
  position: number | null;
}

export interface QueryFinding {
  key: string;
  kind:
    | "losing"
    | "low_ctr"
    | "near_page_one"
    | "cannibalisation"
    | "question_gap"
    | "intent_mismatch"
    | "device_gap";
  title: string;
  problem: string;
  recommendation: string;
  url: string | null;
  priority: number;
  confidence: "high" | "medium" | "low";
  evidence: Record<string, unknown>;
}

export interface DeviceRow {
  key: string; // "MOBILE" | "DESKTOP" | "TABLET"
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

interface Agg {
  query: string;
  clicks: number;
  impressions: number;
  posW: number;
  pages: Map<string, { clicks: number; impressions: number; posW: number }>;
}

function aggregate(rows: QPRow[]): Map<string, Agg> {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const a =
      m.get(r.query) ??
      ({
        query: r.query,
        clicks: 0,
        impressions: 0,
        posW: 0,
        pages: new Map(),
      } as Agg);
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    const w = r.position != null ? r.position * r.impressions : 0;
    a.posW += w;
    const p = a.pages.get(r.page) ?? { clicks: 0, impressions: 0, posW: 0 };
    p.clicks += r.clicks;
    p.impressions += r.impressions;
    p.posW += w;
    a.pages.set(r.page, p);
    m.set(r.query, a);
  }
  return m;
}

const pos = (a: { posW: number; impressions: number }) =>
  a.impressions > 0 ? Math.round((a.posW / a.impressions) * 10) / 10 : null;

/** A generic CTR-by-position curve, used only to say "lower than typical".
 * It is a rule of thumb, not a measurement for this site. */
export function typicalCtr(position: number): number {
  if (position <= 1.5) return 0.28;
  if (position <= 2.5) return 0.15;
  if (position <= 3.5) return 0.1;
  if (position <= 5.5) return 0.06;
  if (position <= 10.5) return 0.025;
  return 0.01;
}

const QUESTION =
  /^(who|what|when|where|why|how|can|could|does|do|is|are|should|will)\b/i;
const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "is",
  "are",
  "do",
  "does",
  "how",
  "what",
  "why",
  "when",
  "where",
  "who",
  "can",
  "i",
  "my",
  "me",
  "you",
  "your",
  "it",
  "with",
  "at",
  "by",
  "from",
  "be",
  "uk",
]);
export const contentWords = (q: string): string[] =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

const TRANSACTIONAL =
  /\b(buy|price|prices|cheap|cheapest|tickets?|deal|deals|discount|order|for sale|shop)\b/i;
const INFORMATIONAL_PATH = /\/(blog|guides?|news|articles?|faq|learn)\//i;

export interface IntelInput {
  recent: QPRow[];
  previous: QPRow[];
  /** page URL -> title/slug text, from our own live checks */
  pageText: Map<string, string>;
  /** Bing impressions for the same queries (corroboration only) */
  bingImpressions?: Map<string, number>;
  devices?: DeviceRow[];
}

export function buildQueryFindings(input: IntelInput): QueryFinding[] {
  const out: QueryFinding[] = [];
  const now = aggregate(input.recent);
  const before = aggregate(input.previous);
  const bing = input.bingImpressions ?? new Map<string, number>();
  const withBing = (q: string) =>
    bing.has(q) ? { bingImpressions: bing.get(q) } : {};
  const topPage = (a: Agg) =>
    [...a.pages.entries()].sort(
      (x, y) => y[1].impressions - x[1].impressions,
    )[0];

  // 1. Queries losing clicks or impressions
  const losing = [...before.values()]
    .map((b) => ({ b, n: now.get(b.query) }))
    .filter(
      ({ b, n }) =>
        (b.clicks >= 8 || b.impressions >= 100) &&
        ((n?.clicks ?? 0) <= b.clicks * 0.5 ||
          (n?.impressions ?? 0) <= b.impressions * 0.5),
    )
    .sort(
      (x, y) =>
        y.b.clicks - (y.n?.clicks ?? 0) - (x.b.clicks - (x.n?.clicks ?? 0)) ||
        y.b.impressions - x.b.impressions,
    )
    .slice(0, 5);
  for (const { b, n } of losing) {
    const tp = topPage(b);
    out.push({
      key: `losing:${b.query}`,
      kind: "losing",
      title: `Searches for "${b.query}" are falling`,
      problem: `Clicks went from ${b.clicks} to ${n?.clicks ?? 0} and impressions from ${b.impressions} to ${n?.impressions ?? 0} comparing the last 28 days with the 28 before.`,
      recommendation:
        "Open the page that ranks for this search and check whether it is still accurate and still the best answer (dates, prices, availability). Seasonal demand also moves these numbers, so compare with the same period last year before rewriting anything.",
      url: tp?.[0] ?? null,
      priority: Math.min(
        88,
        55 + Math.round(Math.log10(1 + b.clicks + b.impressions / 10) * 12),
      ),
      confidence: b.impressions >= 200 ? "medium" : "low",
      evidence: {
        source: "Google Search Console, 28 days vs the 28 before",
        clicksBefore: b.clicks,
        clicksNow: n?.clicks ?? 0,
        impressionsBefore: b.impressions,
        impressionsNow: n?.impressions ?? 0,
        ...withBing(b.query),
      },
    });
  }

  // 2. High impressions, low CTR for the position
  const lowCtr = [...now.values()]
    .map((a) => ({ a, p: pos(a) }))
    .filter(({ a, p }) => p !== null && p <= 10 && a.impressions >= 100)
    .map(({ a, p }) => ({
      a,
      p: p as number,
      ctr: a.clicks / a.impressions,
      expected: typicalCtr(p as number),
    }))
    .filter((x) => x.ctr < x.expected * 0.5)
    .sort((x, y) => y.a.impressions * y.expected - x.a.impressions * x.expected)
    .slice(0, 5);
  for (const x of lowCtr) {
    const tp = topPage(x.a);
    out.push({
      key: `low_ctr:${x.a.query}`,
      kind: "low_ctr",
      title: `"${x.a.query}" is seen but rarely clicked`,
      problem: `Average position ${x.p} with ${x.a.impressions} impressions but a ${(x.ctr * 100).toFixed(1)}% click rate. Pages at this position typically get about ${(x.expected * 100).toFixed(0)}% (a generic rule of thumb, not a measurement for this site).`,
      recommendation:
        "Make the page title and description match what people searching this actually want, without exaggeration. Keep the existing facts; do not rewrite the page.",
      url: tp?.[0] ?? null,
      priority: Math.min(
        86,
        50 + Math.round(Math.log10(1 + x.a.impressions) * 12),
      ),
      confidence: "medium",
      evidence: {
        source: "Google Search Console, last 28 days",
        position: x.p,
        impressions: x.a.impressions,
        clicks: x.a.clicks,
        typicalClickRate: x.expected,
        ...withBing(x.a.query),
      },
    });
  }

  // 3. Near page one
  const near = [...now.values()]
    .map((a) => ({ a, p: pos(a) }))
    .filter(
      ({ a, p }) => p !== null && p > 10.5 && p <= 20 && a.impressions >= 50,
    )
    .sort((x, y) => y.a.impressions - x.a.impressions)
    .slice(0, 5);
  for (const { a, p } of near) {
    const tp = topPage(a);
    out.push({
      key: `near:${a.query}`,
      kind: "near_page_one",
      title: `"${a.query}" is close to page one`,
      problem: `Average position ${p} with ${a.impressions} impressions in 28 days. A small improvement could move it onto the first page.`,
      recommendation:
        "Strengthen the page that ranks: answer the search more completely, and link to it from your stronger pages with descriptive wording.",
      url: tp?.[0] ?? null,
      priority: Math.min(
        80,
        45 + Math.round(Math.log10(1 + a.impressions) * 11),
      ),
      confidence: "medium",
      evidence: {
        source: "Google Search Console, last 28 days",
        position: p,
        impressions: a.impressions,
        clicks: a.clicks,
        ...withBing(a.query),
      },
    });
  }

  // 4. Cannibalisation: one query, several of our pages sharing the demand
  const cannibal = [...now.values()]
    .filter((a) => a.impressions >= 50 && a.pages.size >= 2)
    .map((a) => ({
      a,
      shares: [...a.pages.entries()]
        .map(([page, v]) => ({
          page,
          ...v,
          share: v.impressions / a.impressions,
        }))
        .filter((s) => s.share >= 0.25)
        .sort((x, y) => y.impressions - x.impressions),
    }))
    .filter((x) => x.shares.length >= 2)
    .sort((x, y) => y.a.impressions - x.a.impressions)
    .slice(0, 4);
  for (const { a, shares } of cannibal) {
    out.push({
      key: `cannibal:${a.query}`,
      kind: "cannibalisation",
      title: `Two of your pages compete for "${a.query}"`,
      problem: `${shares.length} pages each receive at least a quarter of the impressions for this search: ${shares
        .map((s) => `${s.page} (${Math.round(s.share * 100)}%)`)
        .join(", ")}.`,
      recommendation:
        "Decide which page should answer this search. Point the other page's links at it, and make the second page about a clearly different topic. Do not delete either without checking its traffic.",
      url: shares[0].page,
      priority: Math.min(
        78,
        48 + Math.round(Math.log10(1 + a.impressions) * 9),
      ),
      confidence: "medium",
      evidence: {
        source: "Google Search Console, last 28 days",
        impressions: a.impressions,
        pages: shares.map((s) => ({
          page: s.page,
          impressions: s.impressions,
          clicks: s.clicks,
        })),
        ...withBing(a.query),
      },
    });
  }

  // 5. Question searches no page title or URL appears to address
  const pageWords = [...input.pageText.values()].map(
    (t) => new Set(contentWords(t)),
  );
  const gaps = [...now.values()]
    .filter((a) => QUESTION.test(a.query) && a.impressions >= 20)
    .map((a) => {
      const words = contentWords(a.query);
      const best = pageWords.reduce((m, set) => {
        const hit = words.filter((w) => set.has(w)).length;
        return Math.max(m, words.length ? hit / words.length : 1);
      }, 0);
      return { a, best, words };
    })
    .filter((x) => x.words.length >= 2 && x.best < 0.6)
    .sort((x, y) => y.a.impressions - x.a.impressions)
    .slice(0, 4);
  for (const { a, best } of gaps) {
    const tp = topPage(a);
    out.push({
      key: `question:${a.query}`,
      kind: "question_gap",
      title: `People ask "${a.query}" but no page title covers it`,
      problem: `${a.impressions} impressions for this question. Fewer than 60% of its key words (${Math.round(best * 100)}%) appear in any page title or address on your site, so a page may not answer it directly.`,
      recommendation:
        "Check the page that currently shows for it. If it does not answer the question near the top, add a short, factual answer under a heading that uses the question. Only add facts you can verify.",
      url: tp?.[0] ?? null,
      priority: Math.min(
        74,
        42 + Math.round(Math.log10(1 + a.impressions) * 10),
      ),
      confidence: "low",
      evidence: {
        source:
          "Google Search Console, last 28 days; page titles from Ninja Analytics' own checks",
        impressions: a.impressions,
        clicks: a.clicks,
        keyWordsCovered: best,
        ...withBing(a.query),
      },
    });
  }

  // 6. Search intent mismatch (conservative heuristic)
  const mismatch = [...now.values()]
    .filter((a) => TRANSACTIONAL.test(a.query) && a.impressions >= 40)
    .map((a) => ({ a, tp: topPage(a) }))
    .filter(
      ({ a, tp }) =>
        tp &&
        INFORMATIONAL_PATH.test(tp[0]) &&
        !TRANSACTIONAL.test(input.pageText.get(tp[0]) ?? "") &&
        tp[1].clicks / Math.max(1, tp[1].impressions) < 0.02 &&
        a.impressions > 0,
    )
    .sort((x, y) => y.a.impressions - x.a.impressions)
    .slice(0, 3);
  for (const { a, tp } of mismatch) {
    out.push({
      key: `intent:${a.query}`,
      kind: "intent_mismatch",
      title: `"${a.query}" looks like a buying search landing on an information page`,
      problem: `${a.impressions} impressions, mostly to ${tp![0]}, which reads as a guide rather than a place to buy, and few people click.`,
      recommendation:
        "Check whether a page that lets people act (tickets, prices, availability) should rank for this instead. If so, link to it clearly from this guide.",
      url: tp![0],
      priority: 52,
      confidence: "low",
      evidence: {
        source: "Google Search Console, last 28 days (wording heuristic)",
        impressions: a.impressions,
        clicks: a.clicks,
      },
    });
  }

  // 7. Mobile vs desktop
  const dev = new Map(
    (input.devices ?? []).map((d) => [d.key.toUpperCase(), d]),
  );
  const mob = dev.get("MOBILE");
  const desk = dev.get("DESKTOP");
  if (mob && desk && mob.impressions >= 100 && desk.impressions >= 100) {
    const mc = mob.ctr ?? (mob.impressions ? mob.clicks / mob.impressions : 0);
    const dc =
      desk.ctr ?? (desk.impressions ? desk.clicks / desk.impressions : 0);
    const posGap = (mob.position ?? 0) - (desk.position ?? 0);
    if ((dc > 0 && mc < dc * 0.6) || posGap >= 3) {
      out.push({
        key: "device:mobile-gap",
        kind: "device_gap",
        title: "Mobile visitors do noticeably worse than desktop",
        problem: `Mobile click rate ${(mc * 100).toFixed(1)}% at position ${mob.position?.toFixed(1) ?? "?"} versus desktop ${(dc * 100).toFixed(1)}% at position ${desk.position?.toFixed(1) ?? "?"}.`,
        recommendation:
          "Open your main pages on a phone and check the top of the page, the title and the speed of the first screen.",
        url: null,
        priority: 58,
        confidence: "medium",
        evidence: {
          source: "Google Search Console by device, last 28 days",
          mobile: mob,
          desktop: desk,
        },
      });
    }
  }

  return out.sort((a, b) => b.priority - a.priority);
}
