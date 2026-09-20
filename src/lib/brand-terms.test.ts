import { describe, expect, it } from "vitest";
import { brandTokensFor, isBrandedQuery } from "@/lib/brand-terms";

describe("brandTokensFor", () => {
  it("derives tokens from domain and name, dropping stopwords/TLDs", () => {
    const tokens = brandTokensFor({
      domain: "ninjatickets.co.uk",
      name: "NinjaTickets UK",
    });
    expect(tokens).toContain("ninjatickets");
    // "co"/"uk" are dropped: "co" is a stopword, "uk" is under the 3-char
    // minimum - neither is meaningful enough to drive a branded match.
    expect(tokens).not.toContain("co");
    expect(tokens).not.toContain("uk");
  });

  it("drops short/common tokens", () => {
    const tokens = brandTokensFor({
      domain: "example.com",
      name: "Example Co",
    });
    expect(tokens).not.toContain("co");
    expect(tokens).not.toContain("com");
    expect(tokens).toContain("example");
  });

  it("dedupes tokens shared by domain and name", () => {
    const tokens = brandTokensFor({ domain: "acme.com", name: "Acme" });
    expect(tokens.filter((t) => t === "acme")).toHaveLength(1);
  });
});

describe("isBrandedQuery", () => {
  // Name is "Acme" only (not "Acme Widgets") so "widgets" never itself
  // becomes a brand token - otherwise the "unrelated query" fixture below
  // would collide with the site's own name.
  const tokens = brandTokensFor({ domain: "acme.com", name: "Acme" });

  it("matches a query containing a brand token", () => {
    expect(isBrandedQuery("acme discount code", tokens)).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(isBrandedQuery("best widgets near me", tokens)).toBe(false);
  });

  it("returns false with no brand tokens", () => {
    expect(isBrandedQuery("acme", [])).toBe(false);
  });

  it("matches whole words only, not substrings", () => {
    // "acme" should not match inside "academic"
    expect(isBrandedQuery("academic widgets", tokens)).toBe(false);
  });
});
