// Private, read-only Ninja Analytics MCP server.
//
// Answers ChatGPT's questions from the data Ninja Analytics already stores in
// the local database, through a dedicated least-privilege Postgres role
// (ninja_mcp_reader, migration 0029): SELECT only, an explicit table list,
// read-only transactions, short statement timeout. It never calls Google,
// Bing or any other external service, never writes, and exposes no free-form
// SQL. Listens on loopback only; reach it from ChatGPT through an outbound
// OpenAI Secure MCP Tunnel (see README.md).
import http from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ToolError } from "./lib/common.mjs";
import { callTool, toolDefinitions } from "./lib/tools.mjs";

export const SERVER_INFO = {
  name: "ninja-analytics-readonly",
  version: "1.0.0",
};
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 65_536;
const CALL_DEADLINE_MS = 25_000;
const RATE_PER_MINUTE = 240;
const MAX_CONCURRENT = 4;

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function send(res, status, body, extra = {}) {
  const value = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(value),
    ...extra,
  });
  res.end(value);
}

export function tokenMatches(header, token) {
  if (!token) return true;
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * @param {{ db: { query: Function }, token?: string, now?: () => Date, log?: Function }} deps
 */
export function createMcpServer({
  db,
  token,
  now = () => new Date(),
  log = () => {},
}) {
  let inflight = 0;
  let windowStart = Date.now();
  let windowCount = 0;

  return http.createServer(async (req, res) => {
    if (req.url !== "/mcp") return send(res, 404, { error: "Not found" });
    if (!LOOPBACK_HOST.test(req.headers.host ?? ""))
      return send(res, 403, { error: "Loopback host only" });
    if (req.headers.origin)
      return send(res, 403, { error: "Browser requests are not accepted" });
    if (!tokenMatches(req.headers.authorization, token))
      return send(
        res,
        401,
        { error: "Unauthorised" },
        { "www-authenticate": 'Bearer realm="ninja-mcp"' },
      );
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      return res.end();
    }
    if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
      return send(res, 415, { error: "JSON required" });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY)
        return send(res, 413, { error: "Request too large" });
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return send(res, 400, rpcError(null, -32700, "Invalid JSON"));
    }
    if (Array.isArray(m))
      return send(
        res,
        400,
        rpcError(null, -32600, "Batches are not supported"),
      );
    if (m?.jsonrpc !== "2.0" || typeof m.method !== "string")
      return send(res, 400, rpcError(m?.id ?? null, -32600, "Invalid request"));

    if (m.method.startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    if (m.method === "initialize") {
      const asked = m.params?.protocolVersion;
      return send(
        res,
        200,
        ok(m.id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked)
            ? asked
            : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Read-only Ninja Analytics data (Google Search Console, GA4, Bing, site audit, coverage). Start with list_sites or describe_capabilities. Every result carries source, freshness and warnings; report them, and say UNKNOWN or unavailable rather than guessing.",
        }),
      );
    }
    if (m.method === "ping") return send(res, 200, ok(m.id, {}));
    if (m.method === "tools/list")
      return send(res, 200, ok(m.id, { tools: toolDefinitions() }));
    if (m.method !== "tools/call")
      return send(res, 200, rpcError(m.id, -32601, "Method not found"));

    const name = m.params?.name;
    if (typeof name !== "string")
      return send(res, 200, rpcError(m.id, -32602, "Tool name required"));

    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      windowCount = 0;
    }
    if (++windowCount > RATE_PER_MINUTE || inflight >= MAX_CONCURRENT)
      return send(
        res,
        429,
        rpcError(m.id, -32000, "Too many requests; slow down"),
        { "retry-after": "5" },
      );

    inflight++;
    const started = Date.now();
    let outcome = "ok";
    try {
      const result = await Promise.race([
        callTool(name, m.params.arguments ?? {}, { db, now: now() }),
        new Promise((_, rej) =>
          setTimeout(
            () =>
              rej(new ToolError("The query took too long and was cancelled.")),
            CALL_DEADLINE_MS,
          ).unref(),
        ),
      ]);
      send(
        res,
        200,
        ok(m.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        }),
      );
    } catch (e) {
      outcome = e instanceof ToolError ? "rejected" : "error";
      // Database or code faults are logged locally; the caller gets a safe message.
      const message =
        e instanceof ToolError
          ? e.message
          : "Internal error reading stored data.";
      if (outcome === "error")
        log("tool_error", { name, message: String(e?.message).slice(0, 300) });
      send(
        res,
        200,
        ok(m.id, { content: [{ type: "text", text: message }], isError: true }),
      );
    } finally {
      inflight--;
      log("tool_call", {
        name,
        args: Object.keys(m.params.arguments ?? {}),
        outcome,
        ms: Date.now() - started,
      });
    }
  });
}

function loadEnvFile(path) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#")) {
      const k = line.slice(0, i).trim();
      if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim();
    }
  }
}

async function main() {
  if (process.env.NINJA_MCP_ENV) loadEnvFile(process.env.NINJA_MCP_ENV);
  const token = process.env.NINJA_MCP_TOKEN || "";
  if (!token && process.env.NINJA_MCP_ALLOW_NO_AUTH !== "1") {
    console.error(
      "Refusing to start: set NINJA_MCP_TOKEN (or NINJA_MCP_ALLOW_NO_AUTH=1 to rely on the tunnel alone).",
    );
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    host: process.env.NINJA_DB_HOST || "127.0.0.1",
    port: Number(process.env.NINJA_DB_PORT || 5432),
    user: process.env.NINJA_DB_USER,
    password: process.env.NINJA_DB_PASSWORD,
    database: process.env.NINJA_DB_NAME || "postgres",
    max: 3,
    idleTimeoutMillis: 30_000,
    application_name: "ninja-mcp",
  });
  pool.on("error", (e) => console.error("db pool error:", e.message));
  const db = { query: (text, params) => pool.query(text, params) };
  await db.query("select 1");
  const port = Number(process.env.NINJA_MCP_PORT || 47831);
  const log = (event, fields) =>
    console.log(
      JSON.stringify({ t: new Date().toISOString(), event, ...fields }),
    );
  createMcpServer({ db, token, log }).listen(port, "127.0.0.1", () =>
    log("listening", {
      url: `http://127.0.0.1:${port}/mcp`,
      auth: token ? "bearer" : "none (tunnel only)",
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("Failed to start:", e.message);
    process.exit(1);
  });
}
