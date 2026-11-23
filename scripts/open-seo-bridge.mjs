/**
 * OpenSEO MCP bridge for Ninja Analytics local dashboard.
 * Security: loopback-only target, read-only/zero-credit whitelist, no key in
 * browser, no retries or scheduled jobs. All paid research tools are blocked.
 */
const TOOLS = new Set([
  "list_projects",
  "list_saved_keywords",
  "get_rank_tracker",
  "get_ai_visibility_tracker",
  "get_ai_visibility_results",
  "get_ai_visibility_sources",
  "get_ai_visibility_trend",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CALLS_HOUR = 60;
const CACHE_MS = 60_000;

export function safeOpenSeoArgs(tool, candidate) {
  if (!TOOLS.has(tool)) throw new Error("Tool not allowed: chargeable or mutating tools are disabled");
  if (tool === "list_projects") return {};
  if (!candidate || !UUID.test(candidate.projectId ?? "")) {
    throw new Error("Invalid OpenSEO project ID");
  }
  const args = { projectId: candidate.projectId };
  if (tool === "get_rank_tracker" && candidate.trackerId != null) {
    if (!UUID.test(candidate.trackerId)) throw new Error("Invalid rank tracker ID");
    args.trackerId = candidate.trackerId;
    args.limit = 50;
  }
  if (tool === "get_ai_visibility_results" || tool === "get_ai_visibility_sources") {
    args.limit = 25;
    args.competitorGap = false;
    args.branded = "neutral";
  }
  if (tool === "get_ai_visibility_trend") args.days = 28;
  if (tool === "list_saved_keywords") args.limit = 50;
  return args;
}

export function createOpenSeoBridge({
  fetchImpl = fetch,
  now = () => Date.now(),
  baseUrl = "http://127.0.0.1:3001",
  apiKey = "",
} = {}) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) throw new Error("OpenSEO must use a direct loopback HTTP URL");
  let windowStart = now();
  let used = 0;
  const cache = new Map();
  function quota() {
    if (now() - windowStart >= 3_600_000) {
      windowStart = now();
      used = 0;
      cache.clear();
    }
    if (used >= MAX_CALLS_HOUR) throw new Error("OpenSEO read budget reached (60 calls/hour)");
    used += 1;
  }
  async function status() {
    try {
      const response = await fetchImpl(new URL("/api/health", url), {
        signal: AbortSignal.timeout(2500),
      });
      return {
        online: response.ok,
        configured: Boolean(apiKey),
        message: response.ok
          ? "OpenSEO local service is responding. Account access is checked when reading projects."
          : "OpenSEO health returned HTTP " + response.status,
      };
    } catch {
      return { online: false, configured: Boolean(apiKey), message: "No OpenSEO service at 127.0.0.1:3001" };
    }
  }
  async function call(tool, candidate = {}) {
    const args = safeOpenSeoArgs(tool, candidate);
    const key = JSON.stringify({ tool, args });
    const cached = cache.get(key);
    if (cached && now() - cached.when < CACHE_MS) return { ...cached.value, cached: true };
    quota();
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    let response;
    try {
      response = await fetchImpl(new URL("/mcp", url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        signal: AbortSignal.timeout(7000),
      });
    } catch {
      return { ok: false, error: "OpenSEO is unreachable or timed out" };
    }
    if (!response.ok) return { ok: false, error: "OpenSEO returned HTTP " + response.status };
    const text = await response.text();
    if (text.length > 1_000_000) return { ok: false, error: "OpenSEO response exceeded 1 MB" };
    let wire;
    try {
      // Modern MCP clients use JSON; OpenSEO also supports JSON for legacy calls.
      wire = JSON.parse(text);
    } catch {
      return { ok: false, error: "OpenSEO did not return a JSON MCP response" };
    }
    if (wire.error || wire.result?.isError) {
      return { ok: false, error: wire.error?.message ?? "OpenSEO tool returned an error" };
    }
    const structured = wire.result?.structuredContent;
    if (!structured || typeof structured !== "object") {
      return { ok: false, error: "OpenSEO returned no structured result" };
    }
    if (structured.status === "error") {
      return { ok: false, error: structured.message || structured.code || "OpenSEO read failed" };
    }
    const result = { ok: true, data: structured.status === "success" ? structured.data : structured };
    cache.set(key, { when: now(), value: result });
    return result;
  }
  return { status, call };
}
