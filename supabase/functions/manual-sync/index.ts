import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError } from "../_shared/errors.ts";
import {
  parseManualSyncInput,
  expandSources,
  includesUptime,
} from "../_shared/validate.ts";
import { runIntegrationSync, type SiteRow } from "../_shared/sync-run.ts";
import { ADAPTERS } from "../_shared/registry.ts";
import { checkSiteUptime } from "../_shared/uptime.ts";

const SITE_COLUMNS =
  "id,name,domain,website_url,gsc_property,ga4_property_id,bing_site_url";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, cors);
    }

    // Browser trust path: valid session + aal2 + admin allowlist.
    const { userId, admin } = await requireAdminMfa(req);

    const body = await req.json().catch(() => null);
    const parsed = parseManualSyncInput(body);
    if (!parsed.ok) {
      return json(
        400,
        { ok: false, error: "validation_error", message: parsed.error },
        cors,
      );
    }
    const { siteId, source, rangeStart, rangeEnd } = parsed.value;

    // Load the site server-side - external property ids are never taken from
    // the request body.
    const { data: site, error } = await admin
      .from("sites")
      .select(SITE_COLUMNS)
      .eq("id", siteId)
      .maybeSingle();
    if (error) throw error;
    if (!site) {
      return json(404, { ok: false, error: "not_found" }, cors);
    }

    const sources = expandSources(source);
    const runs = [];
    for (const src of sources) {
      const outcome = await runIntegrationSync({
        admin,
        site: site as SiteRow,
        source: src,
        triggerType: "manual",
        requestedBy: userId,
        adapter: ADAPTERS[src],
        rangeStart,
        rangeEnd,
      });
      runs.push(outcome);
    }

    // Uptime has no sync_runs lifecycle (see _shared/uptime.ts) - it is a
    // single probe + insert, run alongside gsc/ga4/bing for "all", or alone
    // for "uptime".
    let uptime;
    if (includesUptime(source)) {
      const siteWithUrl = site as SiteRow & { website_url: string };
      uptime = await checkSiteUptime({
        id: siteWithUrl.id,
        website_url: siteWithUrl.website_url,
      });
      const { error: uptimeError } = await admin
        .from("uptime_checks")
        .insert(uptime);
      if (uptimeError) throw uptimeError;
    }

    // A single-source request that conflicts maps to HTTP 409 so the UI can
    // show "already running". Multi-source ("all") always returns 200 with
    // per-source outcomes.
    if (runs.length === 1 && runs[0].status === "conflict") {
      return json(409, { ok: false, error: "already_running", runs }, cors);
    }

    return json(200, { ok: true, runs, uptime }, cors);
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
