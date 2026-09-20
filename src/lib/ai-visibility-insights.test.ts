import { describe, expect, it } from "vitest";
import {
  computePromptStatuses,
  computeSourceCoverage,
  generatePromptSuggestions,
  type AiVisibilityObservationRow,
  type AiVisibilityPromptRow,
} from "@/lib/ai-visibility-insights";
import { AI_SOURCES } from "@/lib/ai-search-sources";

const SITE = "site-1";

function obs(
  overrides: Partial<AiVisibilityObservationRow> = {},
): AiVisibilityObservationRow {
  return {
    id: `obs-${Math.random()}`,
    siteId: SITE,
    promptId: null,
    promptText: "best blue widgets",
    source: "chatgpt",
    observedAt: "2026-01-15T00:00:00Z",
    isCited: null,
    citedUrl: null,
    competitorDomain: null,
    country: null,
    device: null,
    notes: null,
    ...overrides,
  };
}

function prompt(
  overrides: Partial<AiVisibilityPromptRow> = {},
): AiVisibilityPromptRow {
  return {
    id: "prompt-1",
    siteId: SITE,
    promptText: "best blue widgets",
    category: "generated",
    sourceQuery: "blue widgets",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("computeSourceCoverage", () => {
  it("returns one row per known AI source, even with zero observations", () => {
    const coverage = computeSourceCoverage([]);
    expect(coverage).toHaveLength(AI_SOURCES.length);
    expect(coverage.every((c) => c.observationCount === 0)).toBe(true);
    expect(coverage.every((c) => c.citationRate === null)).toBe(true);
  });

  it("computes citation rate only from observations with a decided answer", () => {
    const observations = [
      obs({ source: "chatgpt", isCited: true }),
      obs({ source: "chatgpt", isCited: false }),
      obs({ source: "chatgpt", isCited: null }), // undecided - excluded from the rate
    ];
    const coverage = computeSourceCoverage(observations);
    const chatgpt = coverage.find((c) => c.source === "chatgpt")!;
    expect(chatgpt.observationCount).toBe(3);
    expect(chatgpt.citedCount).toBe(1);
    expect(chatgpt.citationRate).toBeCloseTo(0.5);
  });

  it("tracks the most recent observation date per source", () => {
    const observations = [
      obs({ source: "gemini", observedAt: "2026-01-01T00:00:00Z" }),
      obs({ source: "gemini", observedAt: "2026-01-20T00:00:00Z" }),
    ];
    const coverage = computeSourceCoverage(observations);
    expect(coverage.find((c) => c.source === "gemini")!.lastObservedAt).toBe(
      "2026-01-20T00:00:00Z",
    );
  });
});

describe("computePromptStatuses", () => {
  it("groups observations under their prompt by id", () => {
    const p = prompt();
    const observations = [
      obs({
        promptId: p.id,
        source: "chatgpt",
        observedAt: "2026-01-01T00:00:00Z",
      }),
      obs({
        promptId: p.id,
        source: "gemini",
        observedAt: "2026-01-10T00:00:00Z",
      }),
    ];
    const [status] = computePromptStatuses([p], observations);
    expect(status.observations).toHaveLength(2);
    expect(status.sourcesCovered.sort()).toEqual(["chatgpt", "gemini"]);
    expect(status.lastObservedAt).toBe("2026-01-10T00:00:00Z");
  });

  it("falls back to a text match when an observation has no prompt_id", () => {
    const p = prompt({ promptText: "best blue widgets" });
    const observations = [
      obs({
        promptId: null,
        promptText: "best blue widgets",
        source: "claude",
      }),
    ];
    const [status] = computePromptStatuses([p], observations);
    expect(status.observations).toHaveLength(1);
  });

  it("returns an empty observation list for a prompt never tested", () => {
    const [status] = computePromptStatuses([prompt()], []);
    expect(status.observations).toHaveLength(0);
    expect(status.lastObservedAt).toBeNull();
  });
});

describe("generatePromptSuggestions", () => {
  it("wraps a plain query as a question, ranked by impressions", () => {
    const suggestions = generatePromptSuggestions([
      { query: "blue widgets", impressions: 500 },
      { query: "red widgets", impressions: 100 },
    ]);
    expect(suggestions[0].sourceQuery).toBe("blue widgets");
    expect(suggestions[0].promptText).toBe(
      "What is the best option for blue widgets?",
    );
  });

  it("leaves an already question-shaped query mostly as-is", () => {
    const [s] = generatePromptSuggestions([
      { query: "how do blue widgets work", impressions: 10 },
    ]);
    expect(s.promptText).toBe("how do blue widgets work?");
  });

  it("respects the limit", () => {
    const queries = Array.from({ length: 20 }, (_, i) => ({
      query: `query ${i}`,
      impressions: i,
    }));
    expect(generatePromptSuggestions(queries, 5)).toHaveLength(5);
  });
});
