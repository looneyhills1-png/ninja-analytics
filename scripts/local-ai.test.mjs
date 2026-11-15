import { describe, expect, it, vi } from "vitest";
import { createLocalAi, pickModel, LIMITS } from "./local-ai.mjs";

const tags = { models: [{ name: "qwen3.5:9b" }, { name: "x" }] };
function mk(chat, limits = {}) {
  const fetchImpl = vi.fn(async (url) => {
    if (String(url).endsWith("/api/tags")) {
      return { ok: true, json: async () => tags };
    }
    return chat();
  });
  const ai = createLocalAi({ fetchImpl, limits: { ...LIMITS, ...limits } });
  return { ai, fetchImpl };
}
const good = () => ({
  ok: true,
  json: async () => ({ message: { content: "Do the first item." } }),
});

describe("local AI", () => {
  it("prefers the installed Qwen model", () => {
    expect(pickModel(["qwen3:4b", "qwen3.5:9b"])).toBe("qwen3.5:9b");
    expect(pickModel(["llama"])).toBeNull();
  });
  it("only ever talks to the local Ollama address", async () => {
    const { ai, fetchImpl } = mk(good);
    await ai.explain({ kind: "portfolio", evidence: { a: 1 } });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    for (const [url] of fetchImpl.mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:11434\//);
    }
  });
  it("answers an identical request from the cache without a second call", async () => {
    const { ai, fetchImpl } = mk(good);
    const a = await ai.explain({ kind: "portfolio", evidence: { a: 1 } });
    const calls = fetchImpl.mock.calls.length;
    const b = await ai.explain({ kind: "portfolio", evidence: { a: 1 } });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });
  it("makes at most two attempts then stops", async () => {
    const chat = vi.fn(async () => ({ ok: false, status: 500 }));
    const { ai } = mk(chat);
    const r = await ai.explain({ kind: "portfolio", evidence: { b: 1 } });
    expect(r.ok).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it("enforces the per-site daily budget", async () => {
    const { ai } = mk(good, { dailyPerSite: 2 });
    for (let i = 0; i < 2; i++) {
      const r = await ai.explain({
        kind: "site-plan",
        siteKey: "s",
        evidence: { i },
      });
      expect(r.ok).toBe(true);
    }
    const r = await ai.explain({
      kind: "site-plan",
      siteKey: "s",
      evidence: { i: 9 },
    });
    expect(r.error).toBe("site_budget_reached");
  });
  it("enforces the overall daily budget, counting retries", async () => {
    const chat = vi.fn(async () => ({ ok: false, status: 500 }));
    const { ai } = mk(chat, { dailyTotal: 3 });
    await ai.explain({ kind: "portfolio", evidence: { n: 1 } }); // 2 attempts
    await ai.explain({ kind: "portfolio", evidence: { n: 2 } }); // 1 attempt, then budget
    expect(chat.mock.calls.length).toBe(3);
    const r = await ai.explain({ kind: "portfolio", evidence: { n: 3 } });
    expect(r.error).toBe("daily_budget_reached");
  });
  it("refuses oversized evidence and unknown kinds", async () => {
    const { ai } = mk(good);
    const big = await ai.explain({
      kind: "portfolio",
      evidence: "x".repeat(20_000),
    });
    expect(big.status).toBe(413);
    const bad = await ai.explain({ kind: "nope", evidence: {} });
    expect(bad.status).toBe(400);
  });
  it("reports unavailable honestly when Ollama is down", async () => {
    const ai = createLocalAi({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const s = await ai.status();
    expect(s.available).toBe(false);
    expect(s.reason).toContain("not running");
    const r = await ai.explain({ kind: "portfolio", evidence: {} });
    expect(r.status).toBe(503);
  });
  it("rejects concurrent runs instead of queueing", async () => {
    let release = () => {};
    const slow = () =>
      new Promise((res) => {
        release = () => res(good());
      });
    const { ai } = mk(slow);
    const first = ai.explain({ kind: "portfolio", evidence: { c: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    const second = await ai.explain({ kind: "portfolio", evidence: { c: 2 } });
    expect(second.error).toBe("busy");
    release();
    await first;
  });
});

import { checkLocalCall } from "./local-access.mjs";

describe("local AI route guard", () => {
  const ok = {
    host: "127.0.0.1:4173",
    "sec-fetch-site": "same-origin",
    "x-ninja-local": "1",
  };
  it("accepts a same-origin loopback call", () => {
    expect(checkLocalCall({ headers: ok }, 4173).ok).toBe(true);
  });
  it("rejects other hosts, cross-site pages, proxies and missing header", () => {
    expect(
      checkLocalCall({ headers: { ...ok, host: "evil.test" } }, 4173).ok,
    ).toBe(false);
    expect(
      checkLocalCall(
        { headers: { ...ok, "sec-fetch-site": "cross-site" } },
        4173,
      ).ok,
    ).toBe(false);
    expect(checkLocalCall({ headers: { ...ok, "cf-ray": "x" } }, 4173).ok).toBe(
      false,
    );
    expect(checkLocalCall({ headers: { host: ok.host } }, 4173).ok).toBe(false);
  });
});
