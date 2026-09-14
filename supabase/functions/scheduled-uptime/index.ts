// scheduled-uptime: hourly availability probe of every active site's public
// URL, recorded into uptime_checks. Auth: the automation secret, same as the
// scheduled syncs.
//
// Scope & safety:
//   * Only URLs already stored in the admin-managed sites table are fetched -
//     never caller-supplied input - and only http(s) URLs are accepted.
//   * Bounded work per run: site cap, per-request timeout, small concurrency.
//   * Self-pruning: rows older than the retention window are deleted here, so
//     the table cannot grow without bound.

import { requireAutomationSecret } from "../_shared/auth.ts";
import { createAdminClient } from "../_shared/database.ts";
import { normalizeError } from "../_shared/errors.ts";
import { json } from "../_shared/response.ts";
import {
  checkSiteUptime,
  type UptimeCheckResult,
  type UptimeSiteRow,
} from "../_shared/uptime.ts";

const MAX_SITES_PER_RUN = 100;
const CONCURRENCY = 5;
const RETENTION_DAYS = 90;

Deno.serve(async (req) => {
  try {
    requireAutomationSecret(req);
  } catch (err) {
    const n = normalizeError(err);
    return json(n.status ?? 401, { ok: false, error: n.code });
  }

  const admin = createAdminClient();
  const { data: sites, error } = await admin
    .from("sites")
    .select("id,website_url")
    .eq("is_active", true)
    .order("name")
    .limit(MAX_SITES_PER_RUN);
  if (error) {
    return json(500, { ok: false, error: normalizeError(error).code });
  }

  const queue = [...((sites ?? []) as UptimeSiteRow[])];
  const results: UptimeCheckResult[] = [];
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      for (;;) {
        const site = queue.shift();
        if (!site) return;
        results.push(await checkSiteUptime(site));
      }
    },
  );
  await Promise.all(workers);

  if (results.length > 0) {
    const { error: insertError } = await admin
      .from("uptime_checks")
      .insert(results);
    if (insertError) {
      return json(500, { ok: false, error: normalizeError(insertError).code });
    }
  }

  // Self-pruning retention.
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 86_400_000,
  ).toISOString();
  await admin.from("uptime_checks").delete().lt("checked_at", cutoff);

  return json(200, {
    ok: true,
    checked: results.length,
    up: results.filter((r) => r.ok).length,
  });
});
