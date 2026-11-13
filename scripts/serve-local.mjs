/**
 * Minimal static server for the built dashboard on a self-hosted install.
 * Binds to loopback only - the dashboard is private to this machine.
 *
 *   node serve-local.mjs <dist-dir> [port]
 *
 * Serves files from <dist-dir> with an SPA fallback to index.html, and a
 * /healthz endpoint for the local health check.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4173);

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

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  const file = await resolveFile(url.pathname).catch(() => null);
  if (!file) {
    res.writeHead(404).end("Not found");
    return;
  }
  const body = await readFile(file);
  const hashed = /\/assets\//.test(file.replace(/\\/g, "/"));
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}).listen(port, "127.0.0.1", () => {
  console.log(
    `Ninja Analytics dashboard on http://127.0.0.1:${port} (root ${root})`,
  );
});
