import { describe, expect, it } from "vitest";
import {
  isCtrFirstCase,
  buildCtrFirstMetaDescription,
  validateFixPlan,
  hasGenuineRelevance,
  type EvidenceSnapshot,
} from "../../supabase/functions/_shared/fix-validation";

function evidence(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    query: "when do oasis tickets go on sale",
    url: "https://ninjatickets.com/guides/oasis-2027-tour/",
    currentPosition: 5,
    impressions: 189,
    clicks: 0,
    ctr: 0,
    categories: [],
    ...overrides,
  };
}

describe("isCtrFirstCase", () => {
  it("mirrors the real Oasis CTR opportunity that motivated this fix (position 9.5, 189 impressions, 0 clicks)", () => {
    expect(isCtrFirstCase(evidence({ currentPosition: 9.5 }))).toBe(true);
  });
  it("is false when the page is already getting clicks", () => {
    expect(isCtrFirstCase(evidence({ clicks: 3 }))).toBe(false);
  });
  it("is false when ranking too poorly for CTR to be the primary lever", () => {
    expect(isCtrFirstCase(evidence({ currentPosition: 25 }))).toBe(false);
  });
  it("is true when explicitly categorized high-impression-low-ctr regardless of position", () => {
    expect(
      isCtrFirstCase(
        evidence({
          currentPosition: 30,
          categories: ["high-impression-low-ctr"],
        }),
      ),
    ).toBe(true);
  });
});

describe("buildCtrFirstMetaDescription", () => {
  it("leads with the real query, never inventing new facts", () => {
    const result = buildCtrFirstMetaDescription(
      "Manchester's biggest festival returns with a stacked lineup.",
      "when do oasis tickets go on sale",
    );
    expect(result).toContain("When do oasis tickets go on sale");
    expect(result).toContain("Manchester's biggest festival returns");
    expect(result!.length).toBeLessThanOrEqual(160);
  });

  it("refuses rather than truncating unsafely when the query itself leaves no room", () => {
    const longQuery = "a".repeat(150);
    expect(buildCtrFirstMetaDescription("short desc", longQuery)).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(buildCtrFirstMetaDescription("", "query")).toBeNull();
    expect(buildCtrFirstMetaDescription("desc", "")).toBeNull();
  });
});

describe("validateFixPlan", () => {
  const baseInput = {
    evidence: evidence({ currentPosition: 9.5 }),
    slug: "oasis-2027-tour",
    currentMetaDescription:
      "Manchester's biggest festival returns with a stacked lineup.",
    generatorControlled: [] as {
      slug: string;
      fields: string[];
      generator: string;
    }[],
  };

  it("approves a well-evidenced CTR-first case on a non-generator-controlled slug", () => {
    const result = validateFixPlan(baseInput);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].type).toBe("meta_description");
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects with a specific reason when the slug's metaDescription is generator-controlled (the real Oasis case)", () => {
    const result = validateFixPlan({
      ...baseInput,
      generatorControlled: [
        {
          slug: "oasis-2027-tour",
          fields: ["title", "metaDescription"],
          generator: "scripts/oasis-official-sync.js",
        },
      ],
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("generator-controlled");
    expect(result.rejected[0].detail?.generator).toBe(
      "scripts/oasis-official-sync.js",
    );
  });

  it("rejects when there isn't enough evidence (low impressions)", () => {
    const result = validateFixPlan({
      ...baseInput,
      evidence: evidence({ currentPosition: 5, impressions: 3, clicks: 0 }),
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("Not enough impressions");
  });

  it("rejects when it isn't actually a CTR-first case", () => {
    const result = validateFixPlan({
      ...baseInput,
      evidence: evidence({ currentPosition: 5, clicks: 10 }),
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("Not a CTR-first case");
  });

  it("rejects when there's no current metaDescription to refine", () => {
    const result = validateFixPlan({
      ...baseInput,
      currentMetaDescription: null,
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("No current metaDescription");
  });
});

describe("hasGenuineRelevance (defense-in-depth re-check for internal-link suggestions)", () => {
  it("rejects the Sale Sharks / Oasis case - 'sale' alone is not genuine relevance", () => {
    expect(hasGenuineRelevance(["sale"])).toBe(false);
  });
  it("accepts a real distinctive shared term", () => {
    expect(hasGenuineRelevance(["oasis"])).toBe(true);
    expect(hasGenuineRelevance(["sale", "llandudno"])).toBe(true);
  });
});
