import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CoverageSection,
  indexedLabel,
} from "@/features/intelligence/CoverageSection";

const checkMutate = vi.fn();
let snapshot: Record<string, unknown> | null;

vi.mock("@/features/intelligence/coverage-api", () => ({
  useCoverageSnapshots: () => ({
    isLoading: false,
    data: { latest: snapshot, previous: null, sitemaps: [] },
  }),
  useCheckCoverage: () => ({
    mutate: checkMutate,
    isPending: false,
    isError: false,
  }),
  useUrlDetails: () => ({
    isLoading: false,
    data: [
      {
        diagnosis: {
          url: "https://ww3supply.com/supplies/",
          shouldBeIndexed: "yes",
          category: "undiscovered",
          reason: "Google has not discovered this page yet.",
          evidence: ["Google: URL is unknown to Google", "Live: HTTP 200"],
          action: "Link to it from an indexed page.",
          needsApproval: false,
        },
        inspectionLink: "https://search.google.com/search-console/inspect?x=1",
        lastInspectedAt: "2026-11-15T12:00:00Z",
      },
      {
        diagnosis: {
          url: "https://ww3supply.com/",
          shouldBeIndexed: "yes",
          category: "healthy",
          reason: "Google reports the page as indexed.",
          evidence: [],
          action: "Nothing to fix.",
          needsApproval: false,
        },
        inspectionLink: null,
        lastInspectedAt: null,
      },
    ],
  }),
}));

const snap = (o: Record<string, unknown>) => ({
  id: "1",
  site_id: "s1",
  captured_at: "2026-11-15T12:00:00Z",
  discovered: 1156,
  live_checked: 60,
  inspected: 52,
  indexed: 47,
  excluded: 3,
  unknown_state: 2,
  technical_errors: 0,
  complete: false,
  detail: {
    excludedByReason: [
      { reason: "Crawled - currently not indexed", count: 3, urls: [] },
    ],
  },
  ...o,
});

beforeEach(() => {
  snapshot = snap({});
  checkMutate.mockClear();
});
afterEach(cleanup);

describe("indexedLabel", () => {
  it("is UNKNOWN until every page is looked up, never extrapolated", () => {
    const text = indexedLabel({
      complete: false,
      indexed: 47,
      inspected: 52,
      discovered: 1156,
    });
    expect(text.startsWith("UNKNOWN")).toBe(true);
    expect(text).toContain("47 of 52");
    expect(text).not.toMatch(/1[01]\d\d indexed/);
  });
  it("gives the number once coverage is complete", () => {
    expect(
      indexedLabel({
        complete: true,
        indexed: 19,
        inspected: 36,
        discovered: 36,
      }),
    ).toBe("19 of 36");
  });
});

describe("CoverageSection", () => {
  it("shows discovered, looked-up and indexed with UNKNOWN for a partial sample", () => {
    render(<CoverageSection siteId="s1" />);
    expect(screen.getByText("1156")).toBeTruthy();
    expect(screen.getByText("52 of 1156")).toBeTruthy();
    expect(
      screen.getByText(/UNKNOWN \(47 of 52 inspected so far/),
    ).toBeTruthy();
    expect(screen.getByText(/Crawled - currently not indexed/)).toBeTruthy();
  });
  it("shows a real total once complete", () => {
    snapshot = snap({
      discovered: 36,
      inspected: 36,
      indexed: 19,
      complete: true,
    });
    render(<CoverageSection siteId="s1" />);
    expect(screen.getByText("19 of 36")).toBeTruthy();
    expect(screen.queryByText(/UNKNOWN/)).toBeNull();
  });
  it("says so when nothing has been checked yet", () => {
    snapshot = null;
    render(<CoverageSection siteId="s1" />);
    expect(screen.getByText(/Not checked yet/)).toBeTruthy();
  });
  it("Check coverage now runs the bounded check", () => {
    render(<CoverageSection siteId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Check coverage now" }));
    expect(checkMutate).toHaveBeenCalledTimes(1);
  });
  it("shows page detail only when opened, problems first", () => {
    render(<CoverageSection siteId="s1" />);
    expect(screen.queryByText("https://ww3supply.com/supplies/")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show page list" }));
    expect(screen.getByText("https://ww3supply.com/supplies/")).toBeTruthy();
    expect(screen.getByText("Open in Search Console")).toBeTruthy();
    expect(screen.queryByText("https://ww3supply.com/")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All pages" }));
    expect(screen.getByText("https://ww3supply.com/")).toBeTruthy();
  });
});
