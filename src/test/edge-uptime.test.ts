import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSiteUptime, probeUrl } from "../../supabase/functions/_shared/uptime";

afterEach(() => vi.unstubAllGlobals());

describe("public uptime URL validation", () => {
  it("accepts normal public sites", () => {
    const site = probeUrl("https://www.example.com/path");
    expect(site?.hostname).toBe("www.example.com");
    expect(probeUrl("http://example.org")?.hostname).toBe("example.org");
  });

  it.each([
    "http://localhost:1234/",
    "http://127.0.0.1/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://service.internal/",
    "http://host.local/",
    "http://localhost.localdomain/",
    "http://example.com:8080/",
    "https://user:password@example.com/",
    "file:///etc/passwd",
    "http://intranet/",
  ])("rejects non-public target %s", (url) => {
    expect(probeUrl(url)).toBeNull();
  });

  it("never fetches rejected destinations", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const site = {
      id: "site-1",
      website_url: "http://127.0.0.1/admin",
    };
    const result = await checkSiteUptime(site);
    expect(result.error).toBe("invalid_url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never follows redirects", async () => {
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const site = { id: "site-1", website_url: "https://example.com" };
    const result = await checkSiteUptime(site);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("redirect_blocked");
  });
});
