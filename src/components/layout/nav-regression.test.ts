import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "@/components/layout/nav";

// Every top-level screen that existed before the five-group regrouping must
// stay reachable from the sidebar.
const LEGACY_ROUTES = [
  "/",
  "/sites",
  "/keywords",
  "/competitors",
  "/site-audit",
  "/indexing",
  "/ai-visibility",
  "/ai-readiness",
  "/content",
  "/opportunities",
  "/sync-runs",
  "/system",
  "/settings/security",
];

describe("sidebar regrouping", () => {
  const linked = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to));
  it.each(LEGACY_ROUTES)("still links %s", (route) => {
    expect(linked).toContain(route);
  });
  it("keeps the existing keyword Fix screens one click away", () => {
    expect(linked).toContain("/keywords/opportunities");
    expect(linked).toContain("/keywords/ctr-optimizer");
  });
  it("uses the five requested groups", () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual([
      null,
      "Fixes",
      "Research",
      "AI Visibility",
      "Settings & advanced",
    ]);
  });
});
