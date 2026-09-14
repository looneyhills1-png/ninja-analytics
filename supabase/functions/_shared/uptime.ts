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

export function probeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
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
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "site-analytics-uptime/1.0" },
    });
    const latency = Math.round(performance.now() - startedAt);
    // Drain (bounded) so the connection can be reused/closed cleanly.
    await res.body?.cancel();
    return {
      site_id: site.id,
      checked_at: checkedAt,
      ok: res.status < 400,
      status_code: res.status,
      latency_ms: latency,
      error: res.status < 400 ? null : `http_${res.status}`,
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
