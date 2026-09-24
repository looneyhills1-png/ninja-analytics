import { describe, expect, it } from "vitest";
import { tokenize } from "@/lib/text-tokens";

describe("tokenize", () => {
  it("strips generic ticketing/commerce filler, including the 2026-09-24 'sale' regression", () => {
    // Real query behind the Sale Sharks <-> Oasis bad recommendation: this
    // must never contain "sale" once tokenized, or a page about "Sale
    // Sharks" (the rugby team) will look relevant to Oasis's ticket page.
    expect(tokenize("when do oasis tickets go on sale")).not.toContain("sale");
    expect(tokenize("when do oasis tickets go on sale")).toContain("oasis");
    expect(tokenize("Sale Sharks Tickets")).not.toContain("sale");
    expect(tokenize("release date")).toEqual([]);
  });

  it("keeps real topical/distinctive words", () => {
    expect(tokenize("Llandudno Chocolate Experience")).toEqual([
      "llandudno",
      "chocolate",
      "experience",
    ]);
  });
});
