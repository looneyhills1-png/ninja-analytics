import { describe, expect, it } from "vitest";
import {
  analyseQuestions,
  candidatePages,
  fuzzyEq,
  stem,
  stripBoilerplate,
  classifyQuestion,
  coverageOfQuestion,
  coveredIntents,
  entityTokens,
  eventLabel,
  markDuplicates,
  matchPage,
  reviewAnswerStructure,
  reviewDecline,
  reviewKeyword,
  reviewQuestionSet,
  type Demand,
  type PageFacts,
} from "../../supabase/functions/_shared/opportunity-validation";

const urls = [
  "https://ninjatickets.com/guides/andre-rieu-tour-tickets/",
  "https://ninjatickets.com/event/andre-rieu-bp-pulse-live-birmingham-2027/",
  "https://ninjatickets.com/guides/edinburghs-christmas-market-tickets/",
  "https://ninjatickets.com/guides/muse-wow-signal-tour-2026-tickets/",
  "https://ninjatickets.com/event/muse-the-o2-2026/",
];

const noDemand: Demand = {
  googleImpressions: 0,
  googleClicks: 0,
  bingImpressions: 0,
  bingClicks: 0,
};
const someDemand: Demand = { ...noDemand, googleImpressions: 40 };

const page = (over: Partial<PageFacts> = {}): PageFacts => ({
  url: "https://ninjatickets.com/guides/andre-rieu-tour-tickets/",
  status: 200,
  noindex: false,
  canonicalOffsite: false,
  words: 800,
  text: "andre rieu tickets birmingham official listing",
  ...over,
});

describe("keyword → page matching", () => {
  it("strips generic words and diacritics", () => {
    expect(entityTokens("andré rieu tour tickets birmingham 2027")).toEqual([
      "andre",
      "rieu",
      "birmingham",
    ]);
  });

  it("prefers the guide page over the event listing and tolerates missing venue words", () => {
    expect(matchPage("andré rieu tour tickets birmingham", urls)?.url).toBe(
      "https://ninjatickets.com/guides/andre-rieu-tour-tickets/",
    );
    expect(matchPage("muse tour tickets o2", urls)?.url).toBe(
      "https://ninjatickets.com/guides/muse-wow-signal-tour-2026-tickets/",
    );
    expect(
      matchPage("edinburgh's christmas market tickets", urls)?.url,
    ).toContain("edinburghs-christmas-market");
  });

  it("does not match unrelated pages", () => {
    expect(matchPage("kehlani tour tickets o2", urls)).toBeNull();
  });
});

describe("question intent", () => {
  const kw = "andré rieu tour tickets birmingham";
  it("recognises real intents and templated filler", () => {
    expect(classifyQuestion(`has ${kw} been cancelled`, kw)).toBe(
      "cancellation",
    );
    expect(classifyQuestion(`did ${kw} go on sale`, kw)).toBe("onsale");
    expect(classifyQuestion(`are ${kw} sold out`, kw)).toBe("availability");
    expect(classifyQuestion(`${kw} price`, kw)).toBe("price");
    expect(classifyQuestion(`is ${kw} legit`, kw)).toBe("legitimacy");
    expect(classifyQuestion(`can ${kw} be transferred`, kw)).toBe("transfer");
    expect(classifyQuestion(`who ${kw} uk`, kw)).toBe("filler");
    expect(classifyQuestion(kw, kw)).toBe("filler");
  });

  it("collapses duplicate intents", () => {
    const qa = analyseQuestions(
      [
        `did ${kw} go on sale`,
        `will ${kw} go on sale`,
        `is ${kw} available`,
        `who ${kw} uk`,
      ],
      kw,
    );
    expect(qa.total).toBe(4);
    expect(qa.filler).toBe(1);
    expect(qa.intents.sort()).toEqual(["availability", "onsale"]);
  });

  it("checks page text before calling an intent missing", () => {
    const c = coveredIntents("Tickets from £45. Sold out dates are marked.");
    expect(c.has("price")).toBe(true);
    expect(c.has("availability")).toBe(true);
    expect(c.has("cancellation")).toBe(false);
  });
});

describe("reviewKeyword", () => {
  const kw = "andré rieu tour tickets birmingham";
  const qs = [`has ${kw} been cancelled`, `is ${kw} available`, `who ${kw} uk`];
  const match = {
    url: "https://ninjatickets.com/guides/andre-rieu-tour-tickets/",
    score: 1,
  };

  it("improves a healthy page that lacks answers when there is demand, with exact FAQ text", () => {
    const v = reviewKeyword({
      keyword: kw,
      questions: qs,
      match,
      page: page({ text: "andre rieu tickets birmingham official listing" }),
      demand: someDemand,
      siteBase: 55,
    });
    expect(v.classification).toBe("content_improvement");
    expect(v.changeType).toBe("edit");
    expect(v.recommendedChange).toContain(
      "Has André Rieu Birmingham been cancelled or postponed?",
    );
    expect(v.recommendedChange).toContain("do not publish unverified facts");
  });

  it("only monitors when there is no first-party demand", () => {
    const v = reviewKeyword({
      keyword: kw,
      questions: qs,
      match,
      page: page(),
      demand: noDemand,
      siteBase: 55,
    });
    expect(v.classification).toBe("monitor");
    expect(v.priority).toBeLessThan(30);
  });

  it("rejects when the page already answers every intent", () => {
    const v = reviewKeyword({
      keyword: kw,
      questions: qs,
      match,
      page: page({
        text: "Andre Rieu tickets are available now. Andre Rieu cancelled? Refund policy applies for Andre Rieu.",
      }),
      demand: someDemand,
      siteBase: 55,
    });
    expect(v.classification).toBe("reject");
    expect(v.reasoning).toContain("already contains content");
  });

  it("rejects an all-filler question set and a duplicate keyword", () => {
    const filler = reviewKeyword({
      keyword: kw,
      questions: [`who ${kw} uk`, `should ${kw} london`, kw],
      match,
      page: page(),
      demand: someDemand,
      siteBase: 55,
    });
    expect(filler.classification).toBe("reject");
    expect(filler.reasoning).toContain("templated");
    const dup = reviewKeyword({
      keyword: "andre rieu tickets",
      questions: qs,
      match,
      page: page(),
      demand: someDemand,
      duplicateOfKeyword: kw,
      siteBase: 55,
    });
    expect(dup.classification).toBe("reject");
    expect(dup.reasoning).toContain("Duplicate");
  });

  it("fixes technical failures first, before judging questions", () => {
    for (const p of [
      page({ status: 404 }),
      page({ noindex: true }),
      page({ canonicalOffsite: true }),
      page({ words: 40 }),
    ]) {
      const v = reviewKeyword({
        keyword: kw,
        questions: qs,
        match,
        page: p,
        demand: someDemand,
        siteBase: 55,
      });
      expect(v.classification).toBe("fix_now");
      expect(v.priority).toBe(95);
      expect(v.changeType).toBe("technical");
    }
  });

  it("wants new content only where a page is missing and demand exists", () => {
    const a = reviewKeyword({
      keyword: "kehlani tour tickets",
      questions: qs,
      match: null,
      page: null,
      demand: someDemand,
      siteBase: 55,
    });
    expect(a.classification).toBe("new_content");
    expect(a.changeType).toBe("new_page");
    const b = reviewKeyword({
      keyword: "kehlani tour tickets",
      questions: qs,
      match: null,
      page: null,
      demand: noDemand,
      siteBase: 55,
    });
    expect(b.classification).toBe("monitor");
  });

  it("keeps the highest-demand keyword per page and flags the rest as duplicates", () => {
    const dups = markDuplicates([
      {
        id: "a",
        keyword: "andre rieu tickets",
        matchUrl: "u1",
        demand: 5,
        intents: 2,
        questions: [],
      },
      {
        id: "b",
        keyword: "andre rieu tour tickets birmingham",
        matchUrl: "u1",
        demand: 40,
        intents: 1,
        questions: [],
      },
      {
        id: "c",
        keyword: "muse",
        matchUrl: "u2",
        demand: 0,
        intents: 1,
        questions: [],
      },
    ]);
    expect([...dups.entries()]).toEqual([
      ["a", "andre rieu tour tickets birmingham"],
    ]);
  });

  it("builds a readable label", () => {
    expect(eventLabel("andré rieu tour tickets birmingham 2027")).toBe(
      "André Rieu Birmingham",
    );
  });
});

describe("reviewQuestionSet (real questions)", () => {
  const match = { url: "https://ww3supply.com/guides/water/", score: 1 };
  const water = page({
    url: match.url,
    text: "How much emergency water to store: store 3 litres per person per day for drinking and hygiene.",
  });

  it("only counts well-formed questions and checks them against the page", () => {
    expect(
      coverageOfQuestion(
        "how much emergency water should i store for my family",
        water.text,
      ),
    ).toBeGreaterThan(0.5);
    const v = reviewQuestionSet({
      keyword: "how much emergency water should i store for my family",
      questions: [
        "how do i purify rainwater for drinking safely at home",
        "how long does stored tap water stay safe to drink",
        "what containers are safe for storing emergency water long term",
        "water storage uk",
      ],
      match,
      page: water,
      siteBase: 65,
      siteLabel: "WW3Supply",
    });
    expect(v.classification).toBe("content_improvement");
    expect(v.recommendedChange).toContain("purify rainwater");
    expect(v.evidence.wellFormedQuestions as number).toBe(3);
  });

  it("rejects when the page already covers nearly everything", () => {
    const v = reviewQuestionSet({
      keyword: "k",
      questions: ["how much water should i store per person per day"],
      match,
      page: water,
      siteBase: 65,
      siteLabel: "x",
    });
    expect(v.classification).toBe("reject");
  });
});

describe("reviewDecline", () => {
  const w = (clicks: number, impressions: number, position: number | null) => ({
    clicks,
    impressions,
    position,
  });
  it("treats a demand collapse with stable position as monitor, not a page fault", () => {
    const v = reviewDecline({
      url: "u",
      previous: w(26, 1000, 8),
      recent: w(2, 300, 8.4),
      page: page(),
      siteBase: 55,
    });
    expect(v.classification).toBe("monitor");
    expect(v.reasoning).toContain("falling demand");
  });
  it("improves content when position worsened on a healthy page", () => {
    const v = reviewDecline({
      url: "u",
      previous: w(26, 500, 6),
      recent: w(5, 480, 11),
      page: page(),
      siteBase: 55,
    });
    expect(v.classification).toBe("content_improvement");
  });
  it("fixes first when the page is broken", () => {
    const v = reviewDecline({
      url: "u",
      previous: w(26, 500, 6),
      recent: w(5, 480, 6),
      page: page({ status: 500 }),
      siteBase: 55,
    });
    expect(v.classification).toBe("fix_now");
  });
});

describe("reviewAnswerStructure", () => {
  it("rejects when only recipes / legal pages are flagged", () => {
    const v = reviewAnswerStructure([
      "https://cannedcooking.com/recipes/lentil-curry/",
      "https://cannedcooking.com/privacy-policy-terms-of-service/",
    ]);
    expect(v.classification).toBe("reject");
  });
  it("only monitors informational pages", () => {
    expect(
      reviewAnswerStructure(["https://ww3supply.com/guides/water/"])
        .classification,
    ).toBe("monitor");
  });
});

describe("matching and boilerplate (regression: false 'already covered')", () => {
  it("stems and tolerates prefixes", () => {
    expect(stem("cooking")).toBe("cook");
    expect(fuzzyEq("cook", "cooking")).toBe(true);
    expect(fuzzyEq("cyberattack", "cyber")).toBe(true);
    expect(fuzzyEq("cyberattack", "cyberattacks")).toBe(true);
    expect(fuzzyEq("water", "wars")).toBe(false);
  });

  it("finds candidate pages for a question keyword by slug overlap, never the homepage", () => {
    const wwUrls = [
      "https://ww3supply.com/",
      "https://ww3supply.com/supplies/water-storage/",
      "https://ww3supply.com/guides/canned-food-cooking/",
      "https://ww3supply.com/blog/when-gas-supplies-are-disrupted/",
    ];
    expect(
      candidatePages(
        "how much emergency water should i store for my family",
        wwUrls,
      )[0],
    ).toBe("https://ww3supply.com/supplies/water-storage/");
    expect(
      candidatePages("how can i cook safely without electricity", wwUrls)[0],
    ).toBe("https://ww3supply.com/guides/canned-food-cooking/");
    expect(candidatePages("zzz qqq", wwUrls)).toEqual([]);
  });

  it("removes sentences repeated across pages so site-wide blurbs do not count as answers", () => {
    const blurb =
      "Ninja compares real ticket prices from authorised sellers so you can see the available options.";
    const pages = ["a", "b", "c", "d", "e"].map(
      (x, i) =>
        `Page ${x} is about artist ${i}. ${blurb} Tickets from £${40 + i}.`,
    );
    const stripped = stripBoilerplate(pages);
    expect(stripped.every((t) => !t.includes("available options"))).toBe(true);
    expect(stripped[0]).toContain("£40");
    // Too few pages to judge: unchanged.
    expect(stripBoilerplate(pages.slice(0, 3))).toEqual(pages.slice(0, 3));
  });

  it("only counts an intent when the sentence names the event (anchored)", () => {
    const text =
      "Concerts\nCandlelight: Multiple dates - check availability from £28.00\nAndre Rieu is touring in 2027.";
    expect(coveredIntents(text).has("availability")).toBe(true);
    expect(coveredIntents(text, ["rieu"]).has("availability")).toBe(false);
    expect(
      coveredIntents("Andre Rieu tickets are available from £60.", [
        "rieu",
      ]).has("availability"),
    ).toBe(true);
  });

  it("credits follow-on sentences in the same paragraph, not other events", () => {
    const text =
      "The Premier League Darts comes to Birmingham. Public sale started at 12:00 on 22 October. Tickets are listed.\nCandlelight Birmingham: check availability from £28.";
    const c = coveredIntents(text, ["premier"]);
    expect(c.has("onsale")).toBe(true);
    expect(c.has("availability")).toBe(false);
  });

  it("requires a concrete price, not just the word price", () => {
    expect(coveredIntents("see our price guide").has("price")).toBe(false);
    expect(coveredIntents("from £28.00").has("price")).toBe(true);
    expect(
      coveredIntents("see the available options").has("availability"),
    ).toBe(false);
  });

  it("flags identical keywords as duplicates even when no page matched", () => {
    const d = markDuplicates([
      {
        id: "1",
        keyword: "how much water should i store",
        matchUrl: null,
        demand: 0,
        intents: 0,
        questions: [],
      },
      {
        id: "2",
        keyword: "How much water should I store?",
        matchUrl: null,
        demand: 0,
        intents: 0,
        questions: [],
      },
    ]);
    expect(d.size).toBe(1);
  });

  it("does not treat different questions that land on the same page as duplicates", () => {
    const water = "https://ww3supply.com/supplies/water-storage/";
    const d = markDuplicates([
      {
        id: "a",
        keyword: "how much emergency water should i store for my family",
        matchUrl: water,
        demand: 0,
        intents: 0,
        questions: [
          "how long does stored water stay safe",
          "what containers are safe for water",
        ],
      },
      {
        id: "b",
        keyword: "how much emergency water should i store for my family",
        matchUrl: water,
        demand: 0,
        intents: 0,
        questions: ["how long does stored water stay safe"],
      },
      {
        id: "c",
        keyword:
          "what emergency supplies should a family buy first on a budget",
        matchUrl: water,
        demand: 0,
        intents: 0,
        questions: ["what food should a family stock"],
      },
    ]);
    // Identical keyword: the one with fewer questions is the duplicate.
    expect([...d.keys()]).toEqual(["b"]);
  });

  it("rejects a set whose only intent is generic how-it-works", () => {
    const kw = "andre rieu tour tickets";
    const v = reviewKeyword({
      keyword: kw,
      questions: [`how does ${kw} work`],
      match: {
        url: "https://ninjatickets.com/guides/andre-rieu-tour-tickets/",
        score: 1,
      },
      page: page(),
      demand: someDemand,
      siteBase: 55,
    });
    expect(v.classification).toBe("reject");
    expect(v.reasoning).toContain("generic");
  });
});
