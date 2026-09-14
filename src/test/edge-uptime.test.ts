import { describe, expect, it } from "vitest";
import { probeUrl } from "../../supabase/functions/_shared/uptime";

describe("probeUrl", () => {
  it("accepts http and https URLs", () => {
    expect(probeUrl("https://example.com")?.href).toBe("https://example.com/");
    expect(probeUrl("http://example.com")?.href).toBe("http://example.com/");
  });

  it("rejects non-http(s) protocols", () => {
    expect(probeUrl("ftp://example.com")).toBeNull();
    expect(probeUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects URLs carrying basic-auth credentials", () => {
    expect(probeUrl("https://user:pass@example.com")).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(probeUrl("not a url")).toBeNull();
    expect(probeUrl("")).toBeNull();
  });
});
