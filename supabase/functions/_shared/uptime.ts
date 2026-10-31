// Shared uptime probe - used by both scheduled-uptime (every active site,
// hourly, automation-secret auth) and manual-sync (one site, on demand,
// admin+aal2 auth) so the check itself has a single implementation.

import { sanitizeMessage } from "./errors.ts";

export const DEFAULT_UPTIME_TIMEOUT_MS = 10_000;

export interface UptimeSiteRow {
  id: string;
  website_url: string;
}

export interface UptimeCheckResult {
  site_id: string;
  checked_at: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

// Uptime is for public websites only. Block obvious internal destinations
// before network I/O. DNS rebinding / private DNS resolution still require
// an outbound network policy; hostname validation alone is not an SSRF boundary.
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
];

export function probeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    // URL canonicalizes alternate IPv4 encodings. Deny all IP literals
    // (including bracketed IPv6) and non-default ports for public probes.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !host.includes(".") ||
      host.startsWith("[") ||
      /^\d+(?:\.\d+){3}$/.test(host) ||
      url.port
    ) {
      return null;
    }
    if (
      INTERNAL_SUFFIXES.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      )
    ) {
      return null;
    }
    if (
      host.split(".").some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
      )
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export async function checkSiteUptime(
  site: UptimeSiteRow,
  timeoutMs = DEFAULT_UPTIME_TIMEOUT_MS,
): Promise<UptimeCheckResult> {
  const checkedAt = new Date().toISOString();
  const url = probeUrl(site.website_url);
  if (!url) {
    return {
      site_id: site.id,
      checked_at: checkedAt,
      ok: false,
      status_code: null,
      latency_ms: null,
      error: "invalid_url",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "site-analytics-uptime/1.0" },
    });
    const latency = Math.round(performance.now() - startedAt);
    // Drain (bounded) so the connection can be reused/closed cleanly.
    await res.body?.cancel();
    // Never follow a redirect to an unchecked destination (including
    // localhost or metadata endpoints). Mark redirects as unavailable.
    const redirectBlocked =
      res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
    const healthy = !redirectBlocked && res.status >= 200 && res.status < 400;
    let error: string | null = null;
    if (redirectBlocked) {
      error = "redirect_blocked";
    } else if (!healthy) {
      error = `http_${res.status}`;
    }
    return {
      site_id: site.id,
      checked_at: checkedAt,
      ok: healthy,
      status_code: res.status || null,
      latency_ms: latency,
      error,
    };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      site_id: site.id,
      checked_at: checkedAt,
      ok: false,
      status_code: null,
      latency_ms: aborted ? timeoutMs : null,
      error: aborted ? "timeout" : sanitizeMessage(err, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}
