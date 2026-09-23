// inspect-urls: on-demand Google URL Inspection for a small, caller-chosen
// batch of URLs (Ranking Growth Roadmap Phase 4). Admin+aal2 triggered, same
// trust model as manual-sync/site-audit-crawl. Never inspects "thousands of
// URLs blindly" - the UI drives what's worth inspecting (the priority queue
// in src/features/indexing/indexing-priority.ts), this function just enforces
// a hard per-request cap as a server-side backstop.

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError } from "../_shared/errors.ts";
import { inspectAndStoreUrls } from "../_shared/gsc-url-inspection.ts";

const MAX_URLS_PER_REQUEST = 10;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, cors);
    }
    const { admin, userId } = await requireAdminMfa(req);

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const siteId = body?.siteId;
    const urls = body?.urls;
    const force = body?.force === true;
    const siteLastmodByUrl =
      body?.siteLastmodByUrl &&
      typeof body.siteLastmodByUrl === "object" &&
      !Array.isArray(body.siteLastmodByUrl)
        ? (body.siteLastmodByUrl as Record<string, string | null>)
        : undefined;

    if (typeof siteId !== "string" || siteId.length === 0) {
      return json(
        400,
        { ok: false, error: "validation_error", message: "siteId is required" },
        cors,
      );
    }
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      !urls.every((u) => typeof u === "string")
    ) {
      return json(
        400,
        {
          ok: false,
          error: "validation_error",
          message: "urls must be a non-empty array of strings",
        },
        cors,
      );
    }
    if (urls.length > MAX_URLS_PER_REQUEST) {
      return json(
        400,
        {
          ok: false,
          error: "validation_error",
          message: `At most ${MAX_URLS_PER_REQUEST} URLs per request (Search Console quota) - split into more than one request.`,
        },
        cors,
      );
    }

    const { data: site, error: siteError } = await admin
      .from("sites")
      .select("id, gsc_property")
      .eq("id", siteId)
      .maybeSingle();
    if (siteError) throw siteError;
    if (!site) return json(404, { ok: false, error: "not_found" }, cors);
    if (!site.gsc_property) {
      return json(
        400,
        {
          ok: false,
          error: "config_missing",
          message: "No GSC property configured for this site",
        },
        cors,
      );
    }

    const results = await inspectAndStoreUrls(
      admin,
      siteId,
      site.gsc_property,
      urls,
      { force, inspectedBy: userId, siteLastmodByUrl },
    );

    return json(
      200,
      {
        ok: true,
        results,
        inspected: results.filter((r) => r.status === "inspected").length,
        skippedCached: results.filter((r) => r.status === "skipped_cached")
          .length,
        failed: results.filter((r) => r.status === "failed").length,
      },
      cors,
    );
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
