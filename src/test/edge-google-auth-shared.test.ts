import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GA4 and GSC must never grow their own, divergent copy of the Google OAuth
// flow - both have to go through the one getGoogleAccessToken() so a
// credential problem (or a fix to one) always applies to both identically.
// This is a static source check rather than an import-graph test because
// google-auth.ts itself needs Deno's runtime (Deno.env, fetch) and isn't
// loadable under Vitest/Node - see errors.ts's own "no Deno/npm imports"
// convention for why shared modules that need it stay untested here.
const SHARED_MODULE = "./google-auth.ts";

function readFn(path: string): string {
  return readFileSync(
    resolve(process.cwd(), "supabase/functions/_shared", path),
    "utf8",
  );
}

describe("GA4/GSC share one Google credential path", () => {
  it("ga4.ts imports getGoogleAccessToken from google-auth.ts", () => {
    const src = readFn("ga4.ts");
    expect(src).toContain(
      `import { getGoogleAccessToken } from "${SHARED_MODULE}"`,
    );
  });

  it("gsc.ts imports getGoogleAccessToken from google-auth.ts", () => {
    const src = readFn("gsc.ts");
    expect(src).toContain(
      `import { getGoogleAccessToken } from "${SHARED_MODULE}"`,
    );
  });

  it("bing.ts does not import the Google credential path (separate API key)", () => {
    const src = readFn("bing.ts");
    expect(src).not.toContain("google-auth.ts");
  });
});
