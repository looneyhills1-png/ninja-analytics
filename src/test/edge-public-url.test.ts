import { describe, expect, it, vi } from "vitest";
import {
  UnsafeUrlError,
  assertResolvesPublic,
  fetchPublic,
  isPrivateIp,
  publicUrl,
} from "../../supabase/functions/_shared/public-url";

const resolverTo =
  (map: Record<string, string[]>) => async (host: string, type: string) => {
    const hit = map[`${host}/${type}`];
    if (!hit) throw new Error("no record");
    return hit;
  };
const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

describe("publicUrl static rules", () => {
  it("accepts ordinary public sites", () => {
    expect(publicUrl("https://www.example.com/path")?.hostname).toBe(
      "www.example.com",
    );
    expect(publicUrl("http://ww3supply.com/")?.hostname).toBe("ww3supply.com");
  });

  it.each([
    "http://localhost/",
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://metadata.google.internal/",
    "http://host.local/",
    "http://nas.lan/",
    "http://intranet/",
    "https://example.com:8443/",
    "https://user:pw@example.com/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("refuses %s", (raw) => {
    expect(publicUrl(raw)).toBeNull();
  });
});

describe("isPrivateIp", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "ff02::1",
    "999.1.1.1",
    "garbage",
  ])("treats %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "93.184.216.34",
    "2606:4700::1111",
  ])("treats %s as public", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("assertResolvesPublic", () => {
  it("passes public answers, rejects any private answer", async () => {
    await expect(
      assertResolvesPublic(
        "a.example.com",
        resolverTo({ "a.example.com/A": ["93.184.216.34"] }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertResolvesPublic(
        "a.example.com",
        resolverTo({
          "a.example.com/A": ["93.184.216.34"],
          "a.example.com/AAAA": ["fd00::1"],
        }),
      ),
    ).rejects.toMatchObject({ reason: "blocked_url" });
    await expect(
      assertResolvesPublic(
        "evil.example.com",
        resolverTo({ "evil.example.com/A": ["127.0.0.1"] }),
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
  it("reports names that do not resolve, and skips when no resolver exists", async () => {
    await expect(
      assertResolvesPublic("nx.example.com", resolverTo({})),
    ).rejects.toMatchObject({ reason: "unresolvable" });
    await expect(
      assertResolvesPublic("x.example.com", null),
    ).resolves.toBeUndefined();
  });
});

describe("fetchPublic", () => {
  const pub = resolverTo({
    "example.com/A": ["93.184.216.34"],
    "www.example.com/A": ["93.184.216.35"],
    "rebind.example.com/A": ["10.0.0.9"],
  });

  it("never calls fetch for a refused URL", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchPublic("http://169.254.169.254/", {}, { fetchImpl, resolver: pub }),
    ).rejects.toMatchObject({ reason: "blocked_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never calls fetch when the name resolves to a private address", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchPublic(
        "https://rebind.example.com/",
        {},
        { fetchImpl, resolver: pub },
      ),
    ).rejects.toMatchObject({ reason: "blocked_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows ordinary redirects hop by hop and always asks for manual mode", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://example.com/"))
      .mockResolvedValueOnce(redirect("https://www.example.com/home", 301))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const r = await fetchPublic(
      "http://example.com/",
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, resolver: pub },
    );
    expect(r.response.status).toBe(200);
    expect(r.redirects).toBe(2);
    expect(r.finalUrl).toBe("https://www.example.com/home");
    for (const call of fetchImpl.mock.calls)
      expect(call[1].redirect).toBe("manual");
  });

  it("stops at a redirect to an internal target without requesting it", async () => {
    for (const target of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:8000/",
      "http://[::1]/",
      "file:///etc/passwd",
    ]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(target));
      await expect(
        fetchPublic(
          "https://example.com/",
          {},
          { fetchImpl: fetchImpl as unknown as typeof fetch, resolver: pub },
        ),
      ).rejects.toMatchObject({ reason: "blocked_redirect" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("stops at a redirect whose name resolves to a private address", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://rebind.example.com/"));
    await expect(
      fetchPublic(
        "https://example.com/",
        {},
        { fetchImpl: fetchImpl as unknown as typeof fetch, resolver: pub },
      ),
    ).rejects.toMatchObject({ reason: "blocked_url" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps redirect chains and loops", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://example.com/loop"));
    await expect(
      fetchPublic(
        "https://example.com/",
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          resolver: pub,
          maxRedirects: 3,
        },
      ),
    ).rejects.toMatchObject({ reason: "too_many_redirects" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("returns a non-redirect response untouched", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 404 }));
    const r = await fetchPublic(
      "https://example.com/x",
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, resolver: pub },
    );
    expect(r.response.status).toBe(404);
    expect(r.redirects).toBe(0);
  });
});
