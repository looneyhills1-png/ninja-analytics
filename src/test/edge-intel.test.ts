import { describe, expect, it } from "vitest";
import {
  countAnswerHeadings,
  evaluatePage,
  evaluateRobots,
  findDuplicates,
  inspectStructuredData,
  isOwnedUrl,
  parseRobotsGroups,
  robotsAllows,
} from "../../supabase/functions/_shared/ai-readiness";
import {
  aggregateAiReferrals,
  classifyAiReferrer,
} from "../../supabase/functions/_shared/ai-referrals";
import {
  matchSiteByProjectName,
  normalizeAnalysis,
  normalizeProjects,
  normalizeQueryList,
} from "../../supabase/functions/_shared/neuronwriter";
import {
  checkGuard,
  freshState,
  recordCall,
  recordFailure,
  recordSuccess,
} from "../../supabase/functions/_shared/collector-guard";
import {
  opportunitiesFromDecline,
  opportunitiesFromInspections,
  opportunitiesFromNeuron,
  opportunitiesFromReadiness,
} from "../../supabase/functions/_shared/opportunities";

const ORIGIN = "https://example.com";

describe("robots.txt crawler rules", () => {
  it("matches the most specific group and longest rule", () => {
    const { groups } = parseRobotsGroups(
      [
        "User-agent: *",
        "Disallow: /private/",
        "",
        "User-agent: GPTBot",
        "Disallow: /",
        "",
        "User-agent: Googlebot",
        "Disallow: /shop/",
        "Allow: /shop/public/",
      ].join("\n"),
    );
    expect(robotsAllows(groups, "gptbot", "/")).toBe(false);
    expect(robotsAllows(groups, "bingbot", "/private/x")).toBe(false);
    expect(robotsAllows(groups, "bingbot", "/open")).toBe(true);
    expect(robotsAllows(groups, "googlebot", "/shop/a")).toBe(false);
    expect(robotsAllows(groups, "googlebot", "/shop/public/a")).toBe(true);
    // Googlebot's own group replaces `*`, so /private/ is allowed for it.
    expect(robotsAllows(groups, "googlebot", "/private/x")).toBe(true);
  });

  it("supports wildcards, $ anchors and an empty Disallow", () => {
    const { groups } = parseRobotsGroups(
      "User-agent: *\nDisallow: /*.pdf$\nDisallow:\n",
    );
    expect(robotsAllows(groups, "x", "/a/b.pdf")).toBe(false);
    expect(robotsAllows(groups, "x", "/a/b.pdf?x=1")).toBe(true);
    expect(robotsAllows(groups, "x", "/")).toBe(true);
  });

  it("flags a blocked search crawler as an error and a training bot as a notice", () => {
    const { findings } = evaluateRobots(
      "User-agent: Bingbot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://example.com/s.xml",
      200,
      ORIGIN,
    );
    const by = (k: string) => findings.find((f) => f.checkKey === k)!;
    expect(by("crawler_bingbot").severity).toBe("error");
    expect(by("crawler_gptbot").severity).toBe("notice");
    expect(by("crawler_googlebot").severity).toBe("ok");
    expect(findings.some((f) => f.checkKey === "robots_no_sitemap")).toBe(
      false,
    );
  });

  it("handles missing, erroring and unreachable robots.txt", () => {
    expect(evaluateRobots("", 404, ORIGIN).findings[0].checkKey).toBe(
      "robots_missing",
    );
    expect(evaluateRobots("", 503, ORIGIN).findings[0].severity).toBe("error");
    expect(evaluateRobots(null, null, ORIGIN).findings[0].checkKey).toBe(
      "robots_fetch",
    );
  });
});

const GOOD_HTML = `<html><head><title>T</title>
<link rel="canonical" href="https://example.com/a">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["Product","Thing"]}]}</script>
</head><body><h1>Hello</h1><h2>How does it work?</h2>${"word ".repeat(200)}</body></html>`;

describe("page evaluation (known test issues)", () => {
  it("passes a healthy page with no findings", () => {
    expect(
      evaluatePage({
        url: "https://example.com/a",
        status: 200,
        html: GOOD_HTML,
      }),
    ).toEqual([]);
  });

  it("detects noindex (meta and header), bad canonical, bad JSON-LD, thin content", () => {
    const bad = `<html><head><meta name="robots" content="noindex">
<link rel="canonical" href="https://other.com/x">
<script type="application/ld+json">{ not json</script></head><body><p>short</p></body></html>`;
    const keys = evaluatePage({
      url: "https://example.com/b",
      status: 200,
      xRobotsTag: "noindex, nofollow",
      html: bad,
    }).map((f) => f.checkKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        "noindex_header",
        "noindex_meta",
        "canonical_offsite",
        "structured_data_invalid",
        "title_missing",
        "h1_missing",
        "thin_content",
      ]),
    );
  });

  it("reports HTTP errors, unreachable pages and redirect chains", () => {
    expect(
      evaluatePage({ url: "u", status: 404, html: null })[0].checkKey,
    ).toBe("page_http_error");
    expect(
      evaluatePage({ url: "u", status: null, html: null })[0].checkKey,
    ).toBe("page_unreachable");
    const chain = evaluatePage({
      url: "https://example.com/a",
      status: 200,
      redirectHops: 3,
      html: GOOD_HTML,
    });
    expect(chain.map((f) => f.checkKey)).toContain("redirect_chain");
  });

  it("finds duplicate bodies and ignores thin pages", () => {
    const dup = findDuplicates([
      { url: "a", contentHash: "h", wordCount: 400 },
      { url: "b", contentHash: "h", wordCount: 400 },
      { url: "c", contentHash: "t", wordCount: 10 },
      { url: "d", contentHash: "t", wordCount: 10 },
    ]);
    expect(dup.map((d) => d.url).sort()).toEqual(["a", "b"]);
  });

  it("counts answer headings and parses JSON-LD types", () => {
    expect(
      countAnswerHeadings(
        "<h2>What is it?</h2><h3>Pricing</h3><h2>How to book</h2>",
      ),
    ).toBe(2);
    expect(inspectStructuredData(GOOD_HTML)).toMatchObject({
      blocks: 1,
      invalid: 0,
      types: expect.arrayContaining(["Organization", "Product", "Thing"]),
    });
  });

  it("only treats the site's own host as owned", () => {
    expect(isOwnedUrl("https://www.example.com/x", "example.com")).toBe(true);
    expect(isOwnedUrl("https://evil.com/example.com", "example.com")).toBe(
      false,
    );
    expect(isOwnedUrl("https://sub.example.com/", "example.com")).toBe(false);
  });
});

describe("AI referral classification", () => {
  it("recognises assistants and ignores look-alikes", () => {
    expect(classifyAiReferrer("chatgpt.com")).toBe("ChatGPT");
    expect(classifyAiReferrer("https://www.perplexity.ai/search")).toBe(
      "Perplexity",
    );
    expect(classifyAiReferrer("gemini.google.com")).toBe("Gemini");
    expect(classifyAiReferrer("google")).toBeNull();
    expect(classifyAiReferrer("notchatgpt.com")).toBeNull();
    expect(classifyAiReferrer("")).toBeNull();
  });

  it("aggregates per day and provider", () => {
    const rows = aggregateAiReferrals([
      {
        date: "2026-11-01",
        source: "chatgpt.com",
        sessions: 3,
        users: 2,
        pageViews: 5,
      },
      {
        date: "2026-11-01",
        source: "chat.openai.com",
        sessions: 1,
        users: 1,
        pageViews: 1,
      },
      {
        date: "2026-11-01",
        source: "google",
        sessions: 99,
        users: 99,
        pageViews: 99,
      },
    ]);
    expect(rows).toEqual([
      {
        date: "2026-11-01",
        provider: "ChatGPT",
        sessions: 4,
        users: 3,
        pageViews: 6,
      },
    ]);
  });
});

describe("NEURONwriter normalisation", () => {
  it("normalises documented list shapes and drops malformed rows", () => {
    expect(
      normalizeProjects([
        {
          project: "p1",
          name: "ninjatickets.com",
          language: "English",
          engine: "google.co.uk",
        },
        { name: "no id" },
      ]),
    ).toEqual([
      {
        neuronProjectId: "p1",
        name: "ninjatickets.com",
        language: "English",
        engine: "google.co.uk",
      },
    ]);
    expect(
      normalizeQueryList([
        {
          query: "q1",
          keyword: "tickets",
          created: "c",
          updated: "u",
          source: "neuron",
        },
        { query: "q2" },
      ]),
    ).toHaveLength(1);
  });

  it("extracts questions only from a ready analysis and invents nothing", () => {
    const item = {
      neuronQueryId: "q1",
      keyword: "k",
      source: null,
      createdSrc: null,
      updatedSrc: null,
    };
    const ready = normalizeAnalysis(item, {
      status: "ready",
      ideas: {
        suggest_questions: [{ q: "How much?" }, "Where?"],
        people_also_ask: [{ q: "How much?" }],
      },
      competitors: [
        { url: "https://c.com", title: "C", content_score: 71 },
        { url: "https://d.com" },
      ],
    });
    expect(ready.questions).toEqual(["How much?", "Where?"]);
    expect(ready.competitors[0].contentScore).toBe(71);
    expect(ready.competitors[1].contentScore).toBeNull();
    const waiting = normalizeAnalysis(item, {
      status: "in progress",
      ideas: { a: ["x"] },
    });
    expect(waiting.questions).toEqual([]);
    expect(normalizeAnalysis(item, null).status).toBe("unknown");
  });

  it("matches projects to sites by domain", () => {
    const sites = [{ id: "s1", domain: "ninjatickets.com" }];
    expect(matchSiteByProjectName("https://www.NinjaTickets.com/", sites)).toBe(
      "s1",
    );
    expect(matchSiteByProjectName("ebuys.net", sites)).toBeNull();
  });
});

describe("collector guard", () => {
  const now = new Date("2026-11-14T10:00:00Z");

  it("opens the circuit after repeated failures and closes it on success", () => {
    let s = freshState(now);
    s = recordFailure(recordFailure(s, now), now);
    expect(checkGuard(s, now).allowed).toBe(true);
    s = recordFailure(s, now);
    expect(checkGuard(s, now)).toEqual({
      allowed: false,
      reason: "circuit_open",
    });
    expect(checkGuard(s, new Date("2026-11-14T17:00:00Z")).allowed).toBe(true);
    expect(checkGuard(recordSuccess(s), now).allowed).toBe(true);
  });

  it("enforces the daily quota and resets the next UTC day", () => {
    let s = freshState(now);
    for (let i = 0; i < 3; i++) s = recordCall(s, now);
    const cfg = { maxFailures: 3, openMs: 1000, dailyQuota: 3 };
    expect(checkGuard(s, now, cfg)).toEqual({
      allowed: false,
      reason: "quota_exhausted",
    });
    expect(checkGuard(s, new Date("2026-11-15T00:00:01Z"), cfg).allowed).toBe(
      true,
    );
  });
});

describe("opportunities queue", () => {
  const at = "2026-11-14T05:00:00Z";
  const f = (
    checkKey: string,
    severity: "error" | "warning" | "notice" | "ok",
    url: string,
  ) => ({
    checkKey,
    severity,
    url,
    message: `${checkKey} msg`,
    checkedAt: at,
  });

  it("groups readiness findings, skips ok/training-bot items and ranks crawler blocks first", () => {
    const opps = opportunitiesFromReadiness("s1", [
      f("crawler_googlebot", "error", "https://e.com/robots.txt"),
      f("crawler_gptbot", "notice", "https://e.com/robots.txt"),
      f("crawler_bingbot", "ok", "https://e.com/robots.txt"),
      f("thin_content", "notice", "https://e.com/a"),
      f("thin_content", "notice", "https://e.com/b"),
    ]);
    expect(opps.map((o) => o.dedupeKey).sort()).toEqual([
      "readiness:crawler_googlebot",
      "readiness:thin_content",
    ]);
    const sorted = [...opps].sort((a, b) => b.priority - a.priority);
    expect(sorted[0].kind).toBe("crawler_blocked");
    const thin = opps.find((o) => o.kind === "thin_content")!;
    expect(thin.evidence).toMatchObject({ count: 2 });
    expect(thin.expectedImpact.startsWith("Estimate")).toBe(true);
    expect(thin.requiresPublishApproval).toBe(true);
  });

  it("only reports genuine indexing failures", () => {
    const opps = opportunitiesFromInspections("s1", [
      {
        url: "a",
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        lastInspectedAt: at,
      },
      {
        url: "b",
        verdict: "NEUTRAL",
        coverageState: "Excluded by ‘noindex’ tag",
        lastInspectedAt: at,
      },
      {
        url: "c",
        verdict: "NEUTRAL",
        coverageState: "Crawled - currently not indexed",
        lastInspectedAt: at,
      },
      { url: "d", verdict: "FAIL", coverageState: null, lastInspectedAt: at },
    ]);
    expect(opps.map((o) => o.targetUrl)).toEqual(["c", "d"]);
  });

  it("needs enough prior data and a real drop to flag a decline", () => {
    const opps = opportunitiesFromDecline("s1", [
      { page: "small", clicksPrevious: 10, clicksRecent: 0, dataThrough: at },
      {
        page: "stable",
        clicksPrevious: 100,
        clicksRecent: 90,
        dataThrough: at,
      },
      { page: "drop", clicksPrevious: 100, clicksRecent: 40, dataThrough: at },
    ]);
    expect(opps).toHaveLength(1);
    expect(opps[0].targetUrl).toBe("drop");
    expect(opps[0].evidence).toMatchObject({ dropPct: 60 });
  });

  it("surfaces NEURONwriter questions only for ready analyses that have some", () => {
    const opps = opportunitiesFromNeuron("s1", [
      {
        neuronQueryId: "1",
        keyword: "k",
        status: "ready",
        questions: ["Q?"],
        fetchedAt: at,
      },
      {
        neuronQueryId: "2",
        keyword: "k2",
        status: "ready",
        questions: [],
        fetchedAt: at,
      },
      {
        neuronQueryId: "3",
        keyword: "k3",
        status: "waiting",
        questions: ["Q?"],
        fetchedAt: at,
      },
    ]);
    expect(opps.map((o) => o.dedupeKey)).toEqual(["neuron:1"]);
  });
});
