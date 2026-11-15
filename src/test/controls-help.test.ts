import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script shared with the CLI audit
import { findControls } from "../../scripts/audit-controls.mjs";

interface Control {
  file: string;
  line: number;
  kind: string;
  helped: boolean;
  label: string;
}

describe("every button explains itself", () => {
  const controls = findControls("src") as Control[];

  it("finds the controls (guards against the scan silently breaking)", () => {
    expect(controls.length).toBeGreaterThan(80);
  });

  it("has no Button or HelpButton without help text", () => {
    const missing = controls
      .filter((c) => !c.helped)
      .map((c) => `${c.file}:${c.line} ${c.label}`);
    expect(missing).toEqual([]);
  });

  it("has no raw <button> left outside the shared components", () => {
    expect(controls.filter((c) => c.kind === "button")).toEqual([]);
  });

  it("keeps the existing Fix and Run Fix buttons, marked correctly", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      "src/features/keywords/KeywordsOpportunitiesPage.tsx",
      "utf8",
    );
    expect(src).toContain("Generate Fix Prompt");
    expect(src).toMatch(/effect="website"/);
  });
});
