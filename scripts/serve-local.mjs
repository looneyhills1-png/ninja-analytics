/**
 * Local server for the built dashboard on a self-hosted install.
 * Binds to loopback only - the dashboard is private to this machine.
 *
 *   node serve-local.mjs <dist-dir> [port]
 *
 * - Serves <dist-dir> with an SPA fallback to index.html, and /healthz.
 * - Proxies /sb/rest/v1/* and /sb/functions/v1/* to the local Supabase
 *   gateway with a server-minted admin token (see local-access.mjs), so the
 *   browser needs no login and never holds a key stronger than the
 *   publishable one.
 *
 * Config (next to this script, written by deploy-local.ps1):
 *   local-access.json  { "adminUserId": "<uuid>", "stackEnv": "<path to stack .env>",
 *                        "gateway": "http://127.0.0.1:8000" }
 * The JWT secret is read from the stack .env at startup and kept in memory.
 */
import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUpstreamHeaders,
  checkProxyRequest,
  createTokenSource,
} from "./local-access.mjs";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4173);
const here = dirname(fileURLToPath(import.meta.url));

function loadAccess() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(here, "local-access.json"), "utf8"),
    );
    const env = readFileSync(cfg.stackEnv, "utf8");
    const secret = (env.match(/^JWT_SECRET=(.*)$/m) ?? [])[1]?.trim();
    if (!secret || !cfg.adminUserId) return null;
    return {
      gateway: new URL(cfg.gateway ?? "http://127.0.0.1:8000"),
      nextToken: createTokenSource(secret, cfg.adminUserId),
    };
  } catch {
    return null;
  }
}
const access = loadAccess();
if (!access) console.error("local access not configured: /sb will answer 503");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

async function resolveFile(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const full = join(root, rel);
  if (!full.startsWith(root)) return null;
  try {
    const s = await stat(full);
    if (s.isFile()) return full;
  } catch {
    /* fall through to SPA fallback */
  }
  return extname(rel) ? null : join(root, "index.html");
}

function deny(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
  res.end(message);
}

function proxy(req, res) {
  const verdict = checkProxyRequest(
    { headers: req.headers, url: req.url ?? "" },
    port,
  );
  if (!verdict.ok) return deny(res, verdict.status, verdict.reason);
  if (!access) return deny(res, 503, "local access not configured");

  const upstream = httpRequest(
    {
      hostname: access.gateway.hostname,
      port: access.gateway.port,
      method: req.method,
      path: verdict.upstreamPath,
      headers: buildUpstreamHeaders(req.headers, access.nextToken()),
    },
    (up) => {
      // No CORS headers are passed back: only this origin may read responses.
      const headers = { ...up.headers, ...SECURITY_HEADERS };
      delete headers["access-control-allow-origin"];
      delete headers["access-control-allow-credentials"];
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );
  upstream.setTimeout(60_000, () => upstream.destroy());
  upstream.on("error", () => {
    if (!res.headersSent) deny(res, 502, "gateway unavailable");
    else res.destroy();
  });
  req.pipe(upstream);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname.startsWith("/sb/")) return proxy(req, res);

  const file = await resolveFile(url.pathname).catch(() => null);
  if (!file) return deny(res, 404, "Not found");
  const body = await readFile(file);
  const hashed = /\/assets\//.test(file.replace(/\\/g, "/"));
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}).listen(port, "127.0.0.1", () => {
  console.log(
    `Ninja Analytics dashboard on http://127.0.0.1:${port} (root ${root})`,
  );
});
