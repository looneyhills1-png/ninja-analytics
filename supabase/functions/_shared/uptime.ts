// Shared uptime probe - used by both scheduled-uptime (every active site,
// hourly, automation-secret auth) and manual-sync (one site, on demand,
// admin+aal2 auth) so the check itself has a single implementation.

import { sanitizeMessage } from "./errors.ts";
import { UnsafeUrlError, fetchPublic, publicUrl } from "./public-url.ts";

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

/** Static public-web rules (see public-url.ts); null means refuse. */
export function probeUrl(raw: string): URL | null {
  return publicUrl(raw);
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
    // Redirects (http to https, www, trailing slash) are followed, but every
    // hop is re-checked so a redirect cannot lead to an internal address.
    const { response: res } = await fetchPublic(url, {
      method: "GET",
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
    if (err instanceof UnsafeUrlError) {
      return {
        site_id: site.id,
        checked_at: checkedAt,
        ok: false,
        status_code: null,
        latency_ms: null,
        error: err.reason,
      };
    }
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
