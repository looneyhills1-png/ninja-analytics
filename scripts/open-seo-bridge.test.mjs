import test from "node:test";
import assert from "node:assert/strict";
import { createOpenSeoBridge, safeOpenSeoArgs } from "./open-seo-bridge.mjs";

const PROJECT = "123e4567-e89b-42d3-a456-426614174000";

test("paid research and write tools are forbidden, even if named by the browser", () => {
  for (const tool of ["get_domain_overview", "get_backlinks_overview", "research_keywords", "run_ai_visibility_check", "save_ai_visibility_tracker", "run_rank_tracker"]) {
    assert.throws(() => safeOpenSeoArgs(tool, { projectId: PROJECT }), /not allowed/);
  }
  assert.deepEqual(safeOpenSeoArgs("list_projects"), {});
  assert.deepEqual(safeOpenSeoArgs("list_saved_keywords", { projectId: PROJECT, limit: 1000 }), { projectId: PROJECT, limit: 50 });
  assert.throws(() => safeOpenSeoArgs("get_rank_tracker", { projectId: "invalid" }), /Invalid OpenSEO/);
});

test("only direct loopback endpoints are permitted", () => {
  for (const baseUrl of ["https://app.openseo.so", "http://192.168.1.2:3001", "http://evil.invalid/", "http://127.0.0.1:3001/redirect"]) {
    assert.throws(() => createOpenSeoBridge({ baseUrl }), /loopback/);
  }
});

test("MCP uses structured evidence and a server-side key; identical reads hit cache", async () => {
  let requests = 0;
  const fetchImpl = async (url, init) => {
    requests += 1;
    assert.equal(url.toString(), "http://127.0.0.1:3001/mcp");
    assert.equal(init.headers.Authorization, "Bearer oseo_test_key");
    const call = JSON.parse(init.body);
    assert.equal(call.method, "tools/call");
    assert.equal(call.params.name, "list_saved_keywords");
    assert.deepEqual(call.params.arguments, { projectId: PROJECT, limit: 50 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      structuredContent: { rows: [{ id: "saved", keyword: "canned food" }], totalCount: 1, tags: [] },
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const bridge = createOpenSeoBridge({ fetchImpl, apiKey: "oseo_test_key" });
  const first = await bridge.call("list_saved_keywords", { projectId: PROJECT });
  const second = await bridge.call("list_saved_keywords", { projectId: PROJECT });
  assert.equal(first.ok, true);
  assert.equal(first.data.rows[0].keyword, "canned food");
  assert.equal(second.cached, true);
  assert.equal(requests, 1);
});

test("no retries on upstream failures, and no made-up evidence", async () => {
  let requests = 0;
  const bridge = createOpenSeoBridge({ fetchImpl: async () => { requests += 1; return new Response("upstream down", { status: 503 }); } });
  const outcome = await bridge.call("list_projects");
  assert.deepEqual(outcome, { ok: false, error: "OpenSEO returned HTTP 503" });
  assert.equal(requests, 1);
});

test("cost-free reads have a finite per-hour ceiling", async () => {
  let attempts = 0;
  const bridge = createOpenSeoBridge({ fetchImpl: async () => {
    attempts += 1;
    return new Response(JSON.stringify({ result: { structuredContent: { configs: [] } } }), { status: 200 });
  } });
  for (let n = 0; n < 60; n += 1) {
    const id = "123e4567-e89b-42d3-a456-" + n.toString(16).padStart(12, "0");
    const response = await bridge.call("get_rank_tracker", { projectId: id });
    assert.equal(response.ok, true);
  }
  await assert.rejects(() => bridge.call("list_projects"), /budget reached/);
  assert.equal(attempts, 60);
});
