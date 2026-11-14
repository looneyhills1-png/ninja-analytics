import { describe, expect, it } from "vitest";
import { parseAiObservationInput } from "../../supabase/functions/_shared/portfolio-input";

const UUID = "11111111-1111-4111-8111-111111111111";
const base = {
  siteId: UUID,
  promptText: "best site to buy tickets for muse",
  source: "chatgpt",
};

describe("parseAiObservationInput provenance fields", () => {
  it("records the method, brand mention and every cited URL", () => {
    const r = parseAiObservationInput({
      ...base,
      collectionMethod: "manual_chat_ui",
      brandMentioned: true,
      citedUrls: [
        "https://ninjatickets.com/guides/muse-wow-signal-tour-2026-tickets/",
        "https://example.com/other",
        "https://ninjatickets.com/guides/muse-wow-signal-tour-2026-tickets/",
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.collectionMethod).toBe("manual_chat_ui");
    expect(r.value.brandMentioned).toBe(true);
    expect(r.value.citedUrls).toHaveLength(2); // de-duplicated
    // The legacy single-URL column stays populated from the first URL.
    expect(r.value.citedUrl).toBe(r.value.citedUrls[0]);
  });

  it("keeps older callers working with safe defaults", () => {
    const r = parseAiObservationInput(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      collectionMethod: "other_manual",
      brandMentioned: null,
      citedUrls: [],
    });
  });

  it("rejects automated-sounding methods, bad URLs and oversized lists", () => {
    expect(
      parseAiObservationInput({ ...base, collectionMethod: "api_scrape" }).ok,
    ).toBe(false);
    expect(
      parseAiObservationInput({ ...base, citedUrls: ["javascript:alert(1)"] })
        .ok,
    ).toBe(false);
    expect(
      parseAiObservationInput({
        ...base,
        citedUrls: Array.from({ length: 11 }, (_, i) => `https://a.com/${i}`),
      }).ok,
    ).toBe(false);
    expect(parseAiObservationInput({ ...base, brandMentioned: "yes" }).ok).toBe(
      false,
    );
  });
});
