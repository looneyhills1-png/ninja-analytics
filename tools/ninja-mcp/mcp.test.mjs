import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ToolError,
  addDays,
  freshness,
  isIsoDate,
  pageArgs,
  pagination,
  pct,
  resolveRange,
  validateArgs,
} from "./lib/common.mjs";
import { TOOLS, callTool, toolDefinitions } from "./lib/tools.mjs";
import { createMcpServer, tokenMatches } from "./server.mjs";

const NOW = new Date("2026-11-16T00:00:00Z");

describe("date ranges", () => {
  it("defaults to 28 days ending at the latest stored day", () => {
    const r = resolveRange({}, "2026-11-13", NOW);
    expect(r).toMatchObject({
      start: "2026-10-17",
      end: "2026-11-13",
      days: 28,
    });
    expect(r.prevEnd).toBe("2026-10-16");
    expect(r.prevStart).toBe("2026-09-19");
  });
  it("honours explicit dates and refuses more than 180 days", () => {
    expect(
      resolveRange(
        { start_date: "2026-11-01", end_date: "2026-11-10" },
        null,
        NOW,
      ).days,
    ).toBe(10);
    expect(() =>
      resolveRange(
        { start_date: "2026-01-01", end_date: "2026-11-10" },
        null,
        NOW,
      ),
    ).toThrow(/maximum is 180/);
    expect(() => resolveRange({ days: 181 }, null, NOW)).toThrow(ToolError);
    expect(() =>
      resolveRange(
        { start_date: "2026-11-10", end_date: "2026-11-01" },
        null,
        NOW,
      ),
    ).toThrow(/after end_date/);
  });
  it("validates real calendar dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-11-15")).toBe(true);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("argument validation", () => {
  const schema = {
    properties: {
      site: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      start_date: { type: "string", format: "date" },
      engine: { type: "string", enum: ["google", "bing"] },
    },
    required: ["site"],
  };
  it("rejects unknown, missing, mistyped and out-of-range arguments", () => {
    expect(() =>
      validateArgs(schema, { site: "a", sql: "drop table x" }),
    ).toThrow(/Unknown argument/);
    expect(() => validateArgs(schema, {})).toThrow(/Missing/);
    expect(() => validateArgs(schema, { site: "a", limit: 101 })).toThrow(
      /at most 100/,
    );
    expect(() => validateArgs(schema, { site: "a", limit: "5" })).toThrow(
      /integer/,
    );
    expect(() => validateArgs(schema, { site: "a", engine: "yahoo" })).toThrow(
      /one of/,
    );
    expect(() =>
      validateArgs(schema, { site: "a", start_date: "tomorrow" }),
    ).toThrow(/YYYY-MM-DD/);
  });
  it("accepts good input", () => {
    expect(
      validateArgs(schema, { site: "a", limit: 5, engine: "bing" }),
    ).toEqual({ site: "a", limit: 5, engine: "bing" });
  });
});

describe("pagination", () => {
  it("caps the page size at 100 and reports the next offset", () => {
    expect(pageArgs({ limit: 100 }).limit).toBe(100);
    expect(pagination({ limit: 25, offset: 0 }, 47, 25).next_offset).toBe(25);
    expect(
      pagination({ limit: 25, offset: 25 }, 47, 22).next_offset,
    ).toBeNull();
  });
  it("computes percentage change and refuses to divide by zero", () => {
    expect(pct(150, 100)).toBe(50);
    expect(pct(5, 0)).toBeNull();
    expect(pct(5, null)).toBeNull();
  });
});

describe("freshness", () => {
  const range = { start: "2026-10-17", end: "2026-11-13" };
  const bounds = {
    min_date: "2026-08-22",
    max_date: "2026-11-13",
    days: 80,
    rows: 80,
  };
  const status = (hoursAgo, extra = {}) => ({
    last_success_at: new Date(
      NOW.getTime() - hoursAgo * 3_600_000,
    ).toISOString(),
    stale_after_hours: 36,
    consecutive_failures: 0,
    ...extra,
  });
  it("is fresh when synced recently and the window is covered", () => {
    expect(
      freshness({ status: status(5), bounds, range, now: NOW }).state,
    ).toBe("fresh");
  });
  it("is stale when the last sync is too old, and says how old", () => {
    const f = freshness({ status: status(80), bounds, range, now: NOW });
    expect(f.state).toBe("stale");
    expect(f.warnings[0]).toMatch(/80h ago/);
  });
  it("is incomplete when the window reaches outside stored data", () => {
    const f = freshness({
      status: status(5),
      bounds: { ...bounds, min_date: "2026-11-04" },
      range,
      now: NOW,
    });
    expect(f.state).toBe("incomplete");
    expect(f.warnings.join(" ")).toMatch(/2026-11-04/);
  });
  it("is unavailable with no rows, and flags repeated failures", () => {
    expect(
      freshness({ status: status(1), bounds: { rows: 0 }, range, now: NOW })
        .state,
    ).toBe("unavailable");
    const f = freshness({
      status: status(5, { consecutive_failures: 3, last_error_code: "AUTH" }),
      bounds,
      range,
      now: NOW,
    });
    expect(f.warnings.join(" ")).toMatch(/3 sync attempt.*AUTH/);
  });
});

/** A fake database that records every statement and answers by pattern. */
function fakeDb() {
  const calls = [];
  const sites = [
    {
      id: "s1",
      name: "WW3supply",
      domain: "ww3supply.com",
      is_active: true,
      hosting_platform: "chatgpt_sites",
    },
    {
      id: "s2",
      name: "Canned Cooking",
      domain: "cannedcooking.com",
      is_active: true,
      hosting_platform: null,
    },
  ];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (/from public\.sites order by name/.test(text)) return { rows: sites };
      if (/from public\.integration_status where site_id/.test(text))
        return {
          rows: [
            {
              source: "gsc",
              last_success_at: NOW.toISOString(),
              stale_after_hours: 36,
              consecutive_failures: 0,
            },
          ],
        };
      if (/from public\.integration_status/.test(text))
        return {
          rows: [
            {
              site_id: "s1",
              source: "gsc",
              enabled: true,
              last_success_at: NOW.toISOString(),
              last_status: "success",
              consecutive_failures: 0,
              stale_after_hours: 36,
            },
          ],
        };
      if (/min\(metric_date\)/.test(text))
        return {
          rows: [
            {
              min_date: "2026-08-22",
              max_date: "2026-11-13",
              days: 80,
              rows: 80,
            },
          ],
        };
      if (/from c|from public\.search_daily/.test(text))
        return {
          rows: [
            {
              clicks: "10",
              impressions: "100",
              ctr: "0.1",
              average_position: "5",
              total: "1",
              query: "x",
            },
          ],
        };
      return { rows: [] };
    },
  };
}
const ctx = (db) => ({ db, now: NOW });

describe("tools", () => {
  it("every tool is declared read-only and has a strict schema", () => {
    for (const d of toolDefinitions()) {
      expect(d.annotations.readOnlyHint).toBe(true);
      expect(d.inputSchema.additionalProperties).toBe(false);
    }
    expect(TOOLS.length).toBeGreaterThanOrEqual(14);
  });
  it("rejects unknown tools and arbitrary-SQL style arguments", async () => {
    const db = fakeDb();
    await expect(
      callTool("run_sql", { sql: "select 1" }, ctx(db)),
    ).rejects.toThrow(/Unknown tool/);
    await expect(
      callTool("search_queries", { site: "ww3supply.com", sql: "x" }, ctx(db)),
    ).rejects.toThrow(/Unknown argument/);
    expect(db.calls.length).toBe(0);
  });
  it("resolves sites by domain, name or id and rejects strangers", async () => {
    const db = fakeDb();
    const a = await callTool(
      "search_queries",
      { site: "www.WW3Supply.com" },
      ctx(db),
    );
    expect(a.site.id).toBe("s1");
    expect(
      (await callTool("search_queries", { site: "canned cooking" }, ctx(db)))
        .site.id,
    ).toBe("s2");
    await expect(
      callTool("search_queries", { site: "nope.com" }, ctx(db)),
    ).rejects.toThrow(/Unknown site/);
  });
  it("sends user text only as bound parameters, never inside the SQL", async () => {
    const db = fakeDb();
    const evil = "'; drop table sites; --";
    await callTool(
      "search_queries",
      { site: "ww3supply.com", contains: evil, max_ctr: 0.5, sort: "ctr" },
      ctx(db),
    );
    const sqlCalls = db.calls.filter((c) => /with c as/.test(c.text));
    expect(sqlCalls.length).toBeGreaterThan(0);
    for (const c of sqlCalls) expect(c.text).not.toContain("drop table");
    expect(
      sqlCalls[0].params.some((p) => String(p).includes("drop table")),
    ).toBe(true);
  });
  it("escapes LIKE wildcards in text filters", async () => {
    const db = fakeDb();
    await callTool(
      "search_queries",
      { site: "ww3supply.com", contains: "50%_off" },
      ctx(db),
    );
    const p = db.calls.find((c) => /with c as/.test(c.text)).params;
    expect(p).toContain("%50\\%\\_off%");
  });
  it("caps page size and refuses sorting by change without compare", async () => {
    const db = fakeDb();
    await expect(
      callTool(
        "search_queries",
        { site: "ww3supply.com", limit: 500 },
        ctx(db),
      ),
    ).rejects.toThrow(/at most 100/);
    await expect(
      callTool(
        "search_queries",
        { site: "ww3supply.com", sort: "clicks_change" },
        ctx(db),
      ),
    ).rejects.toThrow(/compare/);
  });
  it("labels the result with source, freshness and a window", async () => {
    const r = await callTool(
      "search_queries",
      { site: "ww3supply.com" },
      ctx(fakeDb()),
    );
    expect(r.source.id).toBe("gsc");
    expect(r.freshness.status).toBe("fresh");
    expect(r.range.days).toBe(28);
    expect(r.generated_at).toBeTruthy();
    expect(r.warnings.join(" ")).toMatch(/not a live SERP rank/);
  });
  it("says plainly that GA4 dimensions are not stored", async () => {
    const r = await callTool(
      "ga4_report",
      { site: "ww3supply.com" },
      ctx(fakeDb()),
    );
    expect(r.data.not_stored).toContain("landing pages");
  });
});

describe("server", () => {
  const TOKEN = "test-token-123";
  let server, base;
  beforeAll(async () => {
    server = createMcpServer({ db: fakeDb(), token: TOKEN, now: () => NOW });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/mcp`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  const post = (body, headers = {}) =>
    fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const rpc = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });

  it("rejects requests with no token or the wrong token", async () => {
    expect((await post(rpc("tools/list"), { authorization: "" })).status).toBe(
      401,
    );
    expect(
      (await post(rpc("tools/list"), { authorization: "Bearer wrong" })).status,
    ).toBe(401);
    expect(
      (await post(rpc("tools/list"), { authorization: `Basic ${TOKEN}` }))
        .status,
    ).toBe(401);
  });
  it("rejects browser origins and non-POST methods", async () => {
    expect(
      (await post(rpc("tools/list"), { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    const get = await fetch(base, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
  });
  it("completes initialize, tools/list and a tool call", async () => {
    const init = await (
      await post(rpc("initialize", { protocolVersion: "2025-03-26" }))
    ).json();
    expect(init.result.serverInfo.name).toBe("ninja-analytics-readonly");
    expect(init.result.protocolVersion).toBe("2025-03-26");
    const list = await (await post(rpc("tools/list"))).json();
    expect(list.result.tools.map((t) => t.name)).toContain("search_queries");
    const call = await (
      await post(rpc("tools/call", { name: "list_sites", arguments: {} }))
    ).json();
    expect(call.result.isError).toBe(false);
    expect(call.result.structuredContent.data.map((s) => s.domain)).toEqual([
      "ww3supply.com",
      "cannedcooking.com",
    ]);
  });
  it("returns tool errors as isError, without leaking internals", async () => {
    const bad = await (
      await post(
        rpc("tools/call", {
          name: "search_queries",
          arguments: { site: "ww3supply.com", sql: "x" },
        }),
      )
    ).json();
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/Unknown argument/);
    const unknown = await (
      await post(
        rpc("tools/call", { name: "delete_everything", arguments: {} }),
      )
    ).json();
    expect(unknown.result.isError).toBe(true);
  });
  it("rejects bad JSON, batches and oversized bodies", async () => {
    const raw = (b) =>
      fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: b,
      });
    expect((await raw("{nope")).status).toBe(400);
    expect((await raw("[]")).status).toBe(400);
    expect((await raw("x".repeat(70_000))).status).toBe(413);
  });
  it("only lists read-only tools, so no mutation can be requested", async () => {
    const list = await (await post(rpc("tools/list"))).json();
    for (const t of list.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.name).not.toMatch(
        /^(create|update|delete|insert|write|set|run_sql|execute)/,
      );
    }
  });
  it("compares tokens in constant time and allows no-token mode only when unset", () => {
    expect(tokenMatches("Bearer abc", "abc")).toBe(true);
    expect(tokenMatches("Bearer abd", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(tokenMatches(undefined, "")).toBe(true);
  });
});
