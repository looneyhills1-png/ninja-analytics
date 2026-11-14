// Deterministic validation rules for the opportunities queue. No AI, no
// network: the Edge Function fetches pages and first-party demand, this module
// decides. A suggested question is never treated as "missing content" until
// the actual page text has been checked.

export const RULES_VERSION = "rules-v1";

export type Classification =
  | "fix_now"
  | "content_improvement"
  | "new_content"
  | "monitor"
  | "reject";

export interface Verdict {
  classification: Classification;
  reasoning: string;
  recommendedChange: string | null;
  changeType: "edit" | "new_page" | "technical" | null;
  priority: number;
  evidence: Record<string, unknown>;
}

// -- Text helpers ---------------------------------------------------------------

export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9£]+/g, " ")
    .trim();
}

export const tokens = (s: string): string[] =>
  norm(s).split(" ").filter(Boolean);

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "in",
  "on",
  "at",
  "for",
  "to",
  "is",
  "are",
  "was",
  "be",
  "been",
  "it",
  "this",
  "that",
  "with",
  "from",
  "my",
  "i",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "will",
  "would",
  "have",
  "has",
  "had",
  "how",
  "what",
  "why",
  "when",
  "where",
  "who",
  "which",
  "not",
  "uk",
  "me",
  "you",
  "your",
  "we",
  "our",
  "or",
  "if",
]);

const GENERIC = new Set([
  "tour",
  "tickets",
  "ticket",
  "live",
  "presale",
  "sale",
  "london",
]);

const isYear = (t: string) => /^20\d\d$/.test(t);

/** The distinctive words of a keyword (what a matching page must be about). */
export function entityTokens(keyword: string): string[] {
  return tokens(keyword).filter(
    (t) => !STOP.has(t) && !GENERIC.has(t) && !isYear(t),
  );
}

/** Light stemmer: enough to pair "cook"/"cooking" and "store"/"stores". */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** Stems equal, or one is a prefix of the other (cyber / cyberattack). */
export function fuzzyEq(a: string, b: string): boolean {
  const x = stem(a);
  const y = stem(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.startsWith(short);
}

/** Remove sentences that repeat across many pages of the same site (menus,
 * "how it works" blurbs), so site-wide boilerplate cannot be mistaken for a
 * page answering a question. Needs at least 4 pages to judge. */
export function stripBoilerplate(texts: string[]): string[] {
  if (texts.length < 4) return texts;
  const split = (t: string) =>
    t
      .split(/\n+|(?<=[.!?])\s+|\s{2,}/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 25);
  const df = new Map<string, number>();
  const parts = texts.map(split);
  for (const p of parts) {
    for (const sentence of new Set(p.map((x) => x.toLowerCase()))) {
      df.set(sentence, (df.get(sentence) ?? 0) + 1);
    }
  }
  const limit = Math.max(3, Math.ceil(texts.length * 0.4));
  const drop = new Set([...df].filter(([, n]) => n >= limit).map(([k]) => k));
  return parts.map((p, i) => {
    let out = texts[i];
    for (const sentence of p) {
      if (drop.has(sentence.toLowerCase())) out = out.split(sentence).join(" ");
    }
    return out;
  });
}

/** Top sitemap URLs whose slug shares words with a question-style keyword. */
export function candidatePages(
  keyword: string,
  urls: string[],
  n = 4,
): string[] {
  const want = tokens(keyword).filter((t) => !STOP.has(t) && !GENERIC.has(t));
  const scored: Array<{ url: string; hit: number }> = [];
  for (const url of urls) {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    if (path === "/" || path === "") continue;
    const slug = tokens(path.replace(/[/_-]+/g, " "));
    const hit = want.filter((w) => slug.some((sl) => fuzzyEq(w, sl))).length;
    if (hit > 0) scored.push({ url, hit });
  }
  return scored
    .sort((a, b) => b.hit - a.hit || a.url.length - b.url.length)
    .slice(0, n)
    .map((x) => x.url);
}

// -- Page matching --------------------------------------------------------------

function slugTokens(url: string): Set<string> {
  try {
    const base = tokens(new URL(url).pathname.replace(/[/_-]+/g, " "));
    // Slugs lose apostrophes ("edinburghs"), so also index the singular form.
    return new Set([
      ...base,
      ...base
        .filter((t) => t.length > 3 && t.endsWith("s"))
        .map((t) => t.slice(0, -1)),
    ]);
  } catch {
    return new Set();
  }
}

export interface PageMatch {
  url: string;
  score: number;
}

/** Best sitemap URL for a keyword. Entity tokens must appear in the slug; a
 * URL under `preferPrefix` wins a tie so guide pages beat event listings. */
export function matchPage(
  keyword: string,
  urls: string[],
  preferPrefix = "/guides/",
): PageMatch | null {
  const want = entityTokens(keyword);
  if (want.length === 0) return null;
  let best: (PageMatch & { pref: boolean }) | null = null;
  for (const url of urls) {
    const slug = slugTokens(url);
    const hit = want.filter((t) => slug.has(t)).length;
    const score = hit / want.length;
    // The lead token (artist / event name) must be present; venue and city
    // words may be missing from the slug.
    if (!slug.has(want[0]) || score < 0.5) continue;
    let pref = false;
    try {
      pref = new URL(url).pathname.startsWith(preferPrefix);
    } catch {
      /* ignore */
    }
    if (
      !best ||
      (pref && !best.pref && score >= best.score - 0.35) ||
      (pref === best.pref && score > best.score)
    ) {
      best = { url, score, pref };
    }
  }
  return best ? { url: best.url, score: best.score } : null;
}

// -- Question intent ------------------------------------------------------------

export type Intent =
  | "availability"
  | "cancellation"
  | "onsale"
  | "price"
  | "legitimacy"
  | "transfer"
  | "howto"
  | "other"
  | "filler";

const INTENT_PATTERNS: Array<[Intent, RegExp]> = [
  ["cancellation", /cancel|postpon/],
  ["onsale", /on sale|go on sale|release/],
  ["availability", /available|sold out|sold|in stock/],
  ["price", /price|cost|expensive|cheap|how much/],
  ["legitimacy", /legit|scam|official|genuine|fake/],
  ["transfer", /transfer|refund|resell|resale/],
  ["howto", /\bwork\b/],
];

/** Classify a suggested question after removing the keyword it was built from.
 * Remainders that are only question words / place / year are templated filler. */
export function classifyQuestion(question: string, keyword: string): Intent {
  const kw = new Set(tokens(keyword));
  const rest = tokens(question).filter((t) => !kw.has(t));
  const text = rest.join(" ");
  for (const [intent, re] of INTENT_PATTERNS) {
    if (re.test(text)) return intent;
  }
  const meaningful = rest.filter((t) => !STOP.has(t) && !isYear(t));
  return meaningful.length === 0 ? "filler" : "other";
}

export interface QuestionAnalysis {
  total: number;
  filler: number;
  other: number;
  /** Distinct substantive intents asked about (duplicates collapsed). */
  intents: Intent[];
}

export function analyseQuestions(
  questions: string[],
  keyword: string,
): QuestionAnalysis {
  const intents = new Set<Intent>();
  let filler = 0;
  let other = 0;
  for (const q of questions) {
    const i = classifyQuestion(q, keyword);
    if (i === "filler") filler += 1;
    else if (i === "other") other += 1;
    else intents.add(i);
  }
  return { total: questions.length, filler, other, intents: [...intents] };
}

const COVERAGE: Record<string, RegExp> = {
  cancellation: /cancel|postpon|refund/,
  onsale:
    /on sale|on-sale|presale|pre-sale|pre sale|general sale|public sale|sale (started|opened|begins)|release/,
  availability:
    /sold out|availability|in stock|tickets? (are |remain |still )?available|on sale now/,
  price: /£\s?\d/,
  legitimacy: /official|verified|guarantee|authentic|genuine|legit/,
  transfer: /transfer|resale|resell|name change|refund/,
  howto: /how (it|this|ticket|tickets) work|how to (buy|book)|step by step/,
};

/** An intent counts as covered when a sentence matches it. With `anchors`
 * (the event's lead word) the sentence, or one of the two sentences before it
 * in the same paragraph, must also name the event. That keeps a list of other
 * events' "check availability" links from satisfying it while still crediting
 * follow-on sentences like "Public sale started on 22 October". */
export function coveredIntents(
  pageText: string,
  anchors: string[] = [],
): Set<string> {
  const out = new Set<string>();
  for (const line of pageText.toLowerCase().split(/\n+/)) {
    let carry = 0;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (!sentence.trim()) continue;
      let anchored = anchors.length === 0;
      if (!anchored) {
        const words = tokens(sentence);
        anchored = anchors.some((a) => words.some((w) => fuzzyEq(a, w)));
        if (anchored) carry = 2;
        else if (carry > 0) {
          carry -= 1;
          anchored = true;
        }
      }
      if (!anchored) continue;
      for (const [intent, re] of Object.entries(COVERAGE)) {
        if (re.test(sentence)) out.add(intent);
      }
    }
  }
  return out;
}

// -- Fix text (never states facts the owner has not supplied) -----------------------

const FAQ: Record<string, (label: string) => [string, string]> = {
  availability: (l) => [
    `Are ${l} tickets still available?`,
    "State current availability (on sale, limited or sold out) with the date it was last checked, linking to the live event listing.",
  ],
  cancellation: (l) => [
    `Has ${l} been cancelled or postponed?`,
    "State the current status from the organiser or venue and the date checked; if unchanged, say it is going ahead as scheduled.",
  ],
  onsale: (l) => [
    `When do ${l} tickets go on sale?`,
    "Give the confirmed on-sale or presale date from the listing, or state that dates are not yet announced.",
  ],
  price: (l) => [
    `How much do ${l} tickets cost?`,
    "Give the verified price range from the current listing (for example 'from £X') and what moves the price.",
  ],
  legitimacy: (l) => [
    `Are ${l} tickets safe and legitimate to buy?`,
    "Explain only what the site actually offers (how tickets are sourced and any guarantee) and link to that policy.",
  ],
  transfer: (l) => [
    `Can ${l} tickets be transferred or refunded?`,
    "State the actual transfer and refund policy and link to the full terms.",
  ],
};

export function faqSuggestions(
  missing: string[],
  label: string,
): Array<{ heading: string; answerBrief: string }> {
  return missing
    .filter((i) => FAQ[i])
    .map((i) => {
      const [heading, answerBrief] = FAQ[i](label);
      return { heading, answerBrief };
    });
}

/** "andré rieu tour tickets birmingham" -> "André Rieu Birmingham". */
export function eventLabel(keyword: string): string {
  const cleaned = keyword
    .split(/\s+/)
    .filter((w) => !GENERIC.has(norm(w)) && !isYear(norm(w)))
    .join(" ")
    .trim();
  return cleaned
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// -- Page health ---------------------------------------------------------------

/** Verdict for a keyword that repeats another already-kept opportunity. */
export function duplicateVerdict(
  keyword: string,
  keptKeyword: string,
  evidence: Record<string, unknown> = {},
): Verdict {
  return {
    classification: "reject",
    reasoning: `Duplicate: "${keyword}" resolves to the same page / topic as "${keptKeyword}", which is kept as the primary opportunity.`,
    recommendedChange: null,
    changeType: null,
    priority: 5,
    evidence: { ...evidence, duplicateOf: keptKeyword },
  };
}

export interface PageFacts {
  url: string;
  status: number | null;
  noindex: boolean;
  canonicalOffsite: boolean;
  words: number;
  text: string;
}

export function pageProblem(p: PageFacts): string | null {
  if (p.status === null) return "the page could not be fetched";
  if (p.status >= 400) return `the page returns HTTP ${p.status}`;
  if (p.noindex) return "the page is set to noindex";
  if (p.canonicalOffsite) return "the canonical points to another host";
  if (p.words < 150) return `the page has only ${p.words} words`;
  return null;
}

export interface Demand {
  googleImpressions: number;
  googleClicks: number;
  bingImpressions: number;
  bingClicks: number;
}
const demandTotal = (d: Demand) => d.googleImpressions + d.bingImpressions;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// -- NinjaTickets-style: keyword with an existing page -------------------------

export interface KeywordReviewInput {
  keyword: string;
  questions: string[];
  match: PageMatch | null;
  page: PageFacts | null;
  demand: Demand;
  /** Another keyword already points at the same page and was kept as primary. */
  duplicateOfKeyword?: string | null;
  /** Site-specific priority base for new/improved content. */
  siteBase: number;
}

export function reviewKeyword(input: KeywordReviewInput): Verdict {
  const { keyword, questions, match, page, demand } = input;
  const qa = analyseQuestions(questions, keyword);
  const evidence: Record<string, unknown> = {
    keyword,
    matchedUrl: match?.url ?? null,
    matchScore: match?.score ?? null,
    questions: {
      total: qa.total,
      templatedFiller: qa.filler,
      unclassified: qa.other,
      distinctIntents: qa.intents,
    },
    demand,
    pageStatus: page?.status ?? null,
    pageWords: page?.words ?? null,
  };

  if (input.duplicateOfKeyword) {
    return {
      classification: "reject",
      reasoning: `Duplicate: this keyword resolves to the same page as "${input.duplicateOfKeyword}", which is kept as the primary opportunity.`,
      recommendedChange: null,
      changeType: null,
      priority: 5,
      evidence: { ...evidence, duplicateOf: input.duplicateOfKeyword },
    };
  }

  if (!match || !page) {
    if (demandTotal(demand) > 0) {
      return {
        classification: "new_content",
        reasoning: `No existing page matches "${keyword}", but first-party search shows ${demand.googleImpressions} Google and ${demand.bingImpressions} Bing impressions for it.`,
        recommendedChange: `Create a page for "${keyword}" only if the site genuinely offers it; cover availability, price and on-sale timing from the live listing. Needs your approval before anything is created.`,
        changeType: "new_page",
        priority: clamp(input.siteBase + 5),
        evidence,
      };
    }
    return {
      classification: "monitor",
      reasoning: `No existing page matches "${keyword}" and there is no first-party search demand for it yet. The NEURONwriter analysis alone is not enough to justify new content.`,
      recommendedChange: null,
      changeType: null,
      priority: 20,
      evidence,
    };
  }

  const problem = pageProblem(page);
  if (problem) {
    return {
      classification: "fix_now",
      reasoning: `The matched page ${match.url} has a technical problem: ${problem}.`,
      recommendedChange: `Fix: ${problem}. Then request re-inspection in Search Console.`,
      changeType: "technical",
      priority: 95,
      evidence,
    };
  }

  if (qa.intents.length === 0) {
    return {
      classification: "reject",
      reasoning: `All ${qa.total} suggested questions are templated variations of the keyword (e.g. "who … uk", "should … london") with no distinct intent, so there is nothing real to answer. The page ${match.url} exists and is healthy.`,
      recommendedChange: null,
      changeType: null,
      priority: 5,
      evidence,
    };
  }

  const covered = coveredIntents(page.text, entityTokens(keyword).slice(0, 1));
  const answerable = qa.intents.filter((i) => FAQ[i]);
  if (answerable.length === 0) {
    return {
      classification: "reject",
      reasoning: `The only distinct intent in the suggested questions is a generic "how it works"; there is no specific answer to add to ${match.url}.`,
      recommendedChange: null,
      changeType: null,
      priority: 5,
      evidence,
    };
  }
  const missing = answerable.filter((i) => !covered.has(i));
  evidence.coveredIntents = qa.intents.filter((i) => covered.has(i));
  evidence.missingIntents = missing;

  if (missing.length === 0) {
    return {
      classification: "reject",
      reasoning: `The text of ${match.url} (after removing site-wide boilerplate) already contains content on every distinct intent the questions raise (${answerable.join(", ")}). This is a term check, not a judgement of answer quality.`,
      recommendedChange: null,
      changeType: null,
      priority: 5,
      evidence,
    };
  }

  const faq = faqSuggestions(missing, eventLabel(keyword));
  evidence.faq = faq;
  const change = faq
    .map((f) => `Add heading "${f.heading}" — ${f.answerBrief}`)
    .join("\n");

  if (demandTotal(demand) > 0) {
    return {
      classification: "content_improvement",
      reasoning: `${match.url} is healthy but does not address: ${missing.join(", ")}. First-party search shows ${demand.googleImpressions} Google and ${demand.bingImpressions} Bing impressions for this topic.`,
      recommendedChange: `${change}\nFill each answer from the live listing; do not publish unverified facts.`,
      changeType: "edit",
      priority: clamp(
        input.siteBase + Math.min(10, Math.log2(demandTotal(demand) + 1)),
      ),
      evidence,
    };
  }
  return {
    classification: "monitor",
    reasoning: `${match.url} is healthy and lacks answers on ${missing.join(", ")}, but there is no first-party search demand for this topic yet. Revisit when impressions appear.`,
    recommendedChange: change,
    changeType: "edit",
    priority: 25,
    evidence,
  };
}

/** Jaccard overlap of two sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Flag opportunities that repeat an already-kept one. Two items are
 * duplicates when their keywords are identical, or when they resolve to the
 * same page AND cover the same topic (similar distinctive words or heavily
 * overlapping questions). Different questions that merely land on the same page
 * are NOT duplicates. The kept item has the most demand, then the most
 * questions. */
export function markDuplicates(
  items: Array<{
    id: string;
    keyword: string;
    matchUrl: string | null;
    demand: number;
    intents: number;
    questions: string[];
  }>,
): Map<string, string> {
  const ranked = [...items].sort(
    (a, b) =>
      b.demand - a.demand ||
      b.questions.length - a.questions.length ||
      b.intents - a.intents ||
      a.keyword.localeCompare(b.keyword),
  );
  const kept: typeof items = [];
  const dupOf = new Map<string, string>();
  for (const it of ranked) {
    const entity = new Set(entityTokens(it.keyword).map(stem));
    const qs = new Set(it.questions.map((q) => norm(q)));
    const primary = kept.find((k) => {
      if (norm(k.keyword) === norm(it.keyword)) return true;
      if (!it.matchUrl || k.matchUrl !== it.matchUrl) return false;
      const sameTopic =
        jaccard(entity, new Set(entityTokens(k.keyword).map(stem))) >= 0.6;
      const sameQuestions =
        jaccard(qs, new Set(k.questions.map((q) => norm(q)))) >= 0.5;
      return sameTopic || sameQuestions;
    });
    if (primary) dupOf.set(it.id, primary.keyword);
    else kept.push(it);
  }
  return dupOf;
}

// -- WW3-style: real questions against a guide -----------------------------------

const REAL_Q =
  /^(how|what|why|when|where|who|which|can|should|do|does|is|are|will)\b/;

export function coverageOfQuestion(question: string, pageText: string): number {
  const want = tokens(question).filter((t) => !STOP.has(t));
  if (want.length === 0) return 1;
  const have = tokens(pageText).map(stem);
  const set = new Set(have);
  return (
    want.filter((t) => set.has(stem(t)) || have.some((h) => fuzzyEq(t, h)))
      .length / want.length
  );
}

export interface QuestionSetInput {
  keyword: string;
  questions: string[];
  match: PageMatch | null;
  page: PageFacts | null;
  siteBase: number;
  siteLabel: string;
}

export function reviewQuestionSet(input: QuestionSetInput): Verdict {
  const { keyword, questions, match, page } = input;
  const real = [
    ...new Set(questions.map((q) => q.trim().toLowerCase())),
  ].filter((q) => REAL_Q.test(q) && tokens(q).length >= 5);
  const evidence: Record<string, unknown> = {
    keyword,
    matchedUrl: match?.url ?? null,
    suggestedQuestions: questions.length,
    wellFormedQuestions: real.length,
  };
  if (!match || !page) {
    return {
      classification: real.length > 0 ? "new_content" : "monitor",
      reasoning: `No existing page matches "${keyword}". ${real.length} well-formed suggested questions exist, but there is no first-party demand data for them.`,
      recommendedChange:
        real.length > 0
          ? `Consider a guide answering "${keyword}". Needs your approval before anything is created.`
          : null,
      changeType: real.length > 0 ? "new_page" : null,
      priority: real.length > 0 ? clamp(input.siteBase - 10) : 20,
      evidence,
    };
  }
  const problem = pageProblem(page);
  if (problem) {
    return {
      classification: "fix_now",
      reasoning: `The matched page ${match.url} has a technical problem: ${problem}.`,
      recommendedChange: `Fix: ${problem}.`,
      changeType: "technical",
      priority: 95,
      evidence,
    };
  }
  const uncovered = real.filter((q) => coverageOfQuestion(q, page.text) < 0.7);
  evidence.uncoveredQuestions = uncovered.slice(0, 10);
  evidence.uncoveredCount = uncovered.length;
  if (uncovered.length < 3) {
    return {
      classification: "reject",
      reasoning: `The page ${match.url} already covers the substance of ${real.length - uncovered.length} of ${real.length} well-formed questions; only ${uncovered.length} are not clearly answered, below the threshold for a change.`,
      recommendedChange: null,
      changeType: null,
      priority: 5,
      evidence,
    };
  }
  const top = uncovered.slice(0, 5);
  return {
    classification: "content_improvement",
    reasoning: `${match.url} is healthy but ${uncovered.length} of ${real.length} well-formed questions on "${keyword}" are not answered in its text.`,
    recommendedChange: `Add a short FAQ to ${match.url} answering, from verified sources:\n${top.map((q) => `- ${q}`).join("\n")}`,
    changeType: "edit",
    priority: clamp(input.siteBase + Math.min(8, uncovered.length / 3)),
    evidence,
  };
}

// -- Declining page ---------------------------------------------------------------

export interface Window {
  clicks: number;
  impressions: number;
  /** Impression-weighted average position, null when no impressions. */
  position: number | null;
}

export interface DeclineInput {
  url: string;
  recent: Window;
  previous: Window;
  page: PageFacts | null;
  siteBase: number;
}

export function reviewDecline(input: DeclineInput): Verdict {
  const { recent, previous, page } = input;
  const imprChange =
    previous.impressions > 0
      ? (recent.impressions - previous.impressions) / previous.impressions
      : null;
  const posChange =
    recent.position !== null && previous.position !== null
      ? recent.position - previous.position
      : null;
  const evidence = {
    recent,
    previous,
    impressionChangePct:
      imprChange === null ? null : Math.round(imprChange * 100),
    positionChange: posChange === null ? null : Math.round(posChange * 10) / 10,
  };

  if (page) {
    const problem = pageProblem(page);
    if (problem) {
      return {
        classification: "fix_now",
        reasoning: `Clicks fell and ${problem}.`,
        recommendedChange: `Fix: ${problem}, then request re-inspection.`,
        changeType: "technical",
        priority: 95,
        evidence,
      };
    }
  }
  if (
    imprChange !== null &&
    imprChange <= -0.5 &&
    (posChange === null || posChange < 2)
  ) {
    return {
      classification: "monitor",
      reasoning: `Impressions fell ${Math.round(-imprChange * 100)}% while the average position barely moved (${posChange === null ? "n/a" : (posChange >= 0 ? "+" : "") + posChange.toFixed(1)}), which points to falling demand (for example a finished or seasonal event) rather than a page fault. Only ${previous.clicks} → ${recent.clicks} clicks are involved.`,
      recommendedChange: null,
      changeType: null,
      priority: 30,
      evidence,
    };
  }
  if (posChange !== null && posChange >= 2) {
    return {
      classification: "content_improvement",
      reasoning: `The average position worsened by ${posChange.toFixed(1)} places and clicks fell ${previous.clicks} → ${recent.clicks} while the page is technically healthy.`,
      recommendedChange: `Refresh ${input.url}: confirm event dates, status and prices are current, and compare its headings with the pages now ranking above it.`,
      changeType: "edit",
      priority: clamp(input.siteBase + 15),
      evidence,
    };
  }
  return {
    classification: "monitor",
    reasoning: `Clicks fell ${previous.clicks} → ${recent.clicks}, but the sample is small and neither impressions nor position show a clear cause.`,
    recommendedChange: null,
    changeType: null,
    priority: 30,
    evidence,
  };
}

// -- "No answer-style headings" notices ---------------------------------------------

const NON_QA_PAGE =
  /\/(recipes?|privacy|terms|cookie|contact|about)\b|privacy-policy|terms-of/;

export function reviewAnswerStructure(urls: string[]): Verdict {
  const relevant = urls.filter((u) => {
    try {
      return !NON_QA_PAGE.test(new URL(u).pathname);
    } catch {
      return false;
    }
  });
  const evidence = {
    urls: urls.slice(0, 12),
    relevantPages: relevant.slice(0, 12),
  };
  if (relevant.length === 0) {
    return {
      classification: "reject",
      reasoning: `All ${urls.length} flagged pages are recipes or legal pages, where question-style headings are not expected. The audit check is a heuristic and does not apply to them.`,
      recommendedChange: null,
      changeType: null,
      priority: 5,
      evidence,
    };
  }
  return {
    classification: "monitor",
    reasoning: `${relevant.length} flagged page(s) are informational. The check is a heuristic; add question headings only where real user questions exist (see the question opportunities for that site).`,
    recommendedChange: null,
    changeType: null,
    priority: 15,
    evidence,
  };
}
