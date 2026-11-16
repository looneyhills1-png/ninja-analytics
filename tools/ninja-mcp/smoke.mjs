// Live smoke test: call the running MCP server over HTTP the way a client does.
//   NINJA_MCP_ENV=C:\Ninja\mcp\mcp.env node tools/ninja-mcp/smoke.mjs [tool] [json-args]
// With no arguments it exercises every tool once and prints a one-line summary.
import { readFileSync } from "node:fs";

const env = {};
if (process.env.NINJA_MCP_ENV) {
  for (const l of readFileSync(process.env.NINJA_MCP_ENV, "utf8").split(
    /\r?\n/,
  )) {
    const i = l.indexOf("=");
    if (i > 0) env[l.slice(0, i)] = l.slice(i + 1);
  }
}
const url = `http://127.0.0.1:${env.NINJA_MCP_PORT || 47831}/mcp`;
let id = 0;

async function rpc(method, params, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.NINJA_MCP_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.body.result;
};

const [tool, json] = process.argv.slice(2);
if (tool) {
  const r = await call(tool, json ? JSON.parse(json) : {});
  console.log(JSON.stringify(r.structuredContent ?? r.content, null, 2));
  process.exit(r.isError ? 1 : 0);
}

const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
console.log(
  "initialize:",
  init.body.result.serverInfo.name,
  init.body.result.protocolVersion,
);
const list = await rpc("tools/list");
const names = list.body.result.tools.map((t) => t.name);
console.log("tools:", names.length, names.join(", "));
for (const n of names) {
  const args =
    n === "list_sites" || n === "compare_sites" || n === "describe_capabilities"
      ? {}
      : n === "search_breakdown"
        ? { site: "ww3supply.com", dimension: "device" }
        : n === "content_intelligence"
          ? { site: "ww3supply.com", section: "low_ctr_queries" }
          : n === "system_health"
            ? {}
            : { site: "ww3supply.com" };
  const r = await call(n, args);
  const s = r.structuredContent;
  console.log(
    r.isError ? "ERR " : "ok  ",
    n.padEnd(22),
    r.isError
      ? r.content[0].text
      : `fresh=${s.freshness?.status ?? "-"} through=${s.freshness?.data_through ?? "-"} rows=${s.pagination?.returned ?? "-"}/${s.pagination?.total ?? "-"} warnings=${s.warnings.length}`,
  );
}
