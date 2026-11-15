import { describe, expect, it } from "vitest";
import { buildOpportunityFixPrompt } from "@/features/keywords/generateFixPrompt";

const base = {
  siteName: "WW3 Supply",
  siteDomain: "ww3supply.com",
  status: "validated",
  classification: "content_improvement",
  changeType: "edit",
  targetUrl: "https://ww3supply.com/guides/water-storage/",
  title: "Add FAQ answers to the water storage guide",
  problem: "The guide does not answer how much water to store per person.",
  recommendedChange: "Add an FAQ heading answering the question.",
  proposal: "original proposal text",
  expectedImpact: "More impressions for water questions",
  evidence: { query: "how much water per person", impressions: 120 },
  baselineText: "3 clicks · 120 impressions · avg position 8.2",
  requiresPublishApproval: true,
  ownerNote: null,
};

describe("buildOpportunityFixPrompt", () => {
  it("names the real site, exact URL, problem, evidence and baseline", () => {
    const p = buildOpportunityFixPrompt(base);
    expect(p).toContain("WW3 Supply (ww3supply.com)");
    expect(p).toContain("https://ww3supply.com/guides/water-storage/");
    expect(p).toContain("how much water per person");
    expect(p).toContain("3 clicks");
    expect(p).toContain("Add an FAQ heading");
  });
  it("does not hardcode another site's name", () => {
    expect(buildOpportunityFixPrompt(base)).not.toContain("NinjaTickets");
  });
  it("forbids publishing until the owner approves", () => {
    const p = buildOpportunityFixPrompt(base);
    expect(p).toContain("has NOT approved");
    expect(p).toContain("Do not publish");
  });
  it("records approval when approved, still as a reviewable change", () => {
    const p = buildOpportunityFixPrompt({ ...base, status: "approved" });
    expect(p).toContain("APPROVED");
    expect(p).not.toContain("has NOT approved");
  });
  it("handles site-wide items and missing baseline honestly", () => {
    const p = buildOpportunityFixPrompt({
      ...base,
      targetUrl: null,
      baselineText: null,
      evidence: null,
    });
    expect(p).toContain("no single URL");
    expect(p).toContain("none recorded");
    expect(p).toContain("No structured evidence stored.");
  });
  it("truncates oversized evidence", () => {
    const p = buildOpportunityFixPrompt({
      ...base,
      evidence: { blob: "x".repeat(5000) },
    });
    expect(p).toContain("truncated");
    expect(p.length).toBeLessThan(6000);
  });
});
