import { describe, expect, it } from "vitest";
import {
  buildQueryFindings,
  contentWords,
  typicalCtr,
  type QPRow,
} from "../../supabase/functions/_shared/query-intel";

const r = (
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  position: number | null,
): QPRow => ({ query, page, clicks, impressions, position });

const none = new Map<string, string>();
const find = (f: ReturnType<typeof buildQueryFindings>, kind: string) =>
  f.filter((x) => x.kind === kind);

describe("buildQueryFindings", () => {
  it("flags queries that lost most of their clicks, with before/after evidence", () => {
    const f = buildQueryFindings({
      previous: [r("oasis tickets", "/oasis/", 26, 400, 5)],
      recent: [r("oasis tickets", "/oasis/", 3, 380, 6)],
      pageText: none,
    });
    const x = find(f, "losing")[0];
    expect(x.title).toContain("oasis tickets");
    expect(x.evidence).toMatchObject({ clicksBefore: 26, clicksNow: 3 });
    expect(x.url).toBe("/oasis/");
  });
  it("ignores tiny queries (noise)", () => {
    const f = buildQueryFindings({
      previous: [r("x", "/a/", 2, 10, 5)],
      recent: [r("x", "/a/", 0, 3, 5)],
      pageText: none,
    });
    expect(find(f, "losing")).toHaveLength(0);
  });
  it("finds high-impression low-CTR queries and labels the benchmark as a rule of thumb", () => {
    const f = buildQueryFindings({
      previous: [],
      recent: [r("world war 3 survival kit", "/kit/", 0, 300, 4.2)],
      pageText: none,
    });
    const x = find(f, "low_ctr")[0];
    expect(x.problem).toContain("rule of thumb");
    expect(x.evidence).toMatchObject({ impressions: 300, clicks: 0 });
  });
  it("does not flag a query whose click rate is already typical", () => {
    const f = buildQueryFindings({
      previous: [],
      recent: [r("good", "/g/", 30, 300, 4)],
      pageText: none,
    });
    expect(find(f, "low_ctr")).toHaveLength(0);
  });
  it("finds queries close to page one but not those already on it", () => {
    const f = buildQueryFindings({
      previous: [],
      recent: [r("near", "/n/", 1, 120, 13.4), r("top", "/t/", 9, 120, 3)],
      pageText: none,
    });
    expect(find(f, "near_page_one").map((x) => x.title)).toEqual([
      '"near" is close to page one',
    ]);
  });
  it("detects cannibalisation only when two pages each hold a real share", () => {
    const f = buildQueryFindings({
      previous: [],
      recent: [
        r("water storage", "/a/", 2, 100, 7),
        r("water storage", "/b/", 1, 80, 9),
        r("solo", "/c/", 1, 90, 5),
        r("minor", "/d/", 1, 95, 5),
        r("minor", "/e/", 0, 5, 20),
      ],
      pageText: none,
    });
    const c = find(f, "cannibalisation");
    expect(c).toHaveLength(1);
    expect(c[0].title).toContain("water storage");
    expect(c[0].url).toBe("/a/");
  });
  it("flags question searches no page title covers, but not covered ones", () => {
    const pageText = new Map([
      ["/water/", "How much emergency water should you store"],
    ]);
    const f = buildQueryFindings({
      previous: [],
      recent: [
        r("how can i cook safely without electricity", "/blog/x/", 0, 60, 9),
        r("how much emergency water should i store", "/water/", 3, 80, 6),
      ],
      pageText,
    });
    const g = find(f, "question_gap");
    expect(g).toHaveLength(1);
    expect(g[0].title).toContain("cook safely");
    expect(g[0].confidence).toBe("low");
  });
  it("flags a buying search landing on a guide, conservatively", () => {
    const f = buildQueryFindings({
      previous: [],
      recent: [r("buy emergency radio", "/guides/best-radios/", 0, 80, 8)],
      pageText: new Map([["/guides/best-radios/", "Best wind-up radios"]]),
    });
    expect(find(f, "intent_mismatch")).toHaveLength(1);
  });
  it("reports a mobile versus desktop gap from device data, and not without it", () => {
    const base = { previous: [], recent: [], pageText: none };
    expect(find(buildQueryFindings(base), "device_gap")).toHaveLength(0);
    const f = buildQueryFindings({
      ...base,
      devices: [
        {
          key: "MOBILE",
          clicks: 2,
          impressions: 400,
          ctr: 0.005,
          position: 12,
        },
        {
          key: "DESKTOP",
          clicks: 20,
          impressions: 300,
          ctr: 0.066,
          position: 6,
        },
      ],
    });
    expect(find(f, "device_gap")).toHaveLength(1);
  });
  it("adds Bing impressions as corroboration only when Bing has the query", () => {
    const f = buildQueryFindings({
      previous: [],
      recent: [r("near", "/n/", 1, 120, 13.4)],
      pageText: none,
      bingImpressions: new Map([["near", 44]]),
    });
    expect(find(f, "near_page_one")[0].evidence).toMatchObject({
      bingImpressions: 44,
    });
  });
  it("sorts by priority and never invents a number it was not given", () => {
    const f = buildQueryFindings({
      previous: [r("a", "/a/", 30, 500, 4)],
      recent: [r("a", "/a/", 2, 480, 5), r("n", "/n/", 1, 200, 14)],
      pageText: none,
    });
    expect(f.map((x) => x.priority)).toEqual(
      [...f.map((x) => x.priority)].sort((x, y) => y - x),
    );
    expect(JSON.stringify(f)).not.toMatch(/search volume/i);
  });
});

describe("helpers", () => {
  it("typicalCtr falls with position", () => {
    expect(typicalCtr(1)).toBeGreaterThan(typicalCtr(5));
    expect(typicalCtr(5)).toBeGreaterThan(typicalCtr(15));
  });
  it("contentWords drops stop words", () => {
    expect(contentWords("how can I cook safely without electricity")).toEqual([
      "cook",
      "safely",
      "without",
      "electricity",
    ]);
  });
});
