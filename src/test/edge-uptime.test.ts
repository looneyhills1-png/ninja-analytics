import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSiteUptime,
  probeUrl,
} from "../../supabase/functions/_shared/uptime";

afterEach(() => vi.unstubAllGlobals());

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

describe("probeUrl public-web rules", () => {
  it.each([
    "http://localhost:1234/",
    "http://127.0.0.1/",
    "http://0x7f000001/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://service.internal/",
    "http://intranet/",
    "http://example.com:8080/",
  ])("rejects %s", (url) => {
    expect(probeUrl(url)).toBeNull();
  });
});

describe("checkSiteUptime", () => {
  const site = { id: "s1", website_url: "https://example.com" };

  it("never fetches a refused destination", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await checkSiteUptime({
      ...site,
      website_url: "http://127.0.0.1/admin",
    });
    expect(r.error).toBe("invalid_url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a normal canonical redirect as up", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://www.example.com/" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await checkSiteUptime(site);
    expect(r.ok).toBe(true);
    expect(r.status_code).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("reports a redirect to an internal address as blocked, without requesting it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const r = await checkSiteUptime(site);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("blocked_redirect");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reports real HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x", { status: 503 })),
    );
    const r = await checkSiteUptime(site);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("http_503");
  });
});
