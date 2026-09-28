import { preflight, corsHeaders } from "../_shared/cors.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { normalizeError, SyncError, codeForStatus, isRetryableStatus } from "../_shared/errors.ts";
import { getGoogleAccessToken } from "../_shared/google-auth.ts";
import { fetchWithRetry } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, cors);
    }
    const { admin } = await requireAdminMfa(req);
    const body = (await req.json().catch(() => null)) as { siteId?: string } | null;
    const siteId = body?.siteId?.trim();
    if (!siteId) {
      return json(400, { ok: false, error: "validation_error", message: "siteId is required" }, cors);
    }

    const { data: site, error } = await admin
      .from("sites")
      .select("id,ga4_property_id")
      .eq("id", siteId)
      .maybeSingle();
    if (error) throw error;
    if (!site) return json(404, { ok: false, error: "not_found" }, cors);
    if (!site.ga4_property_id) {
      throw new SyncError("config_missing", "No GA4 property configured for this site");
    }

    const token = await getGoogleAccessToken();
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(
      site.ga4_property_id,
    )}:runRealtimeReport`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dimensions: [{ name: "country" }],
        metrics: [{ name: "activeUsers" }],
        limit: 20,
      }),
    });

    if (!res.ok) {
      throw new SyncError(
        codeForStatus(res.status),
        `GA4 realtime API returned HTTP ${res.status}`,
        { status: res.status, retryable: isRetryableStatus(res.status) },
      );
    }

    const report = (await res.json()) as {
      metricHeaders?: Array<{ name?: string }>;
      rows?: Array<{
        dimensionValues?: Array<{ value?: string }>;
        metricValues?: Array<{ value?: string }>;
      }>;
    };
    const metricIndex = (report.metricHeaders ?? []).findIndex((h) => h.name === "activeUsers");
    const countries = (report.rows ?? [])
      .map((row) => ({
        label: row.dimensionValues?.[0]?.value || "(not set)",
        value: Number(row.metricValues?.[metricIndex]?.value ?? 0),
      }))
      .filter((row) => Number.isFinite(row.value) && row.value > 0)
      .sort((a, b) => b.value - a.value);
    const activeUsers = countries.reduce((sum, row) => sum + row.value, 0);

    return json(200, {
      ok: true,
      activeUsers,
      countries: countries.slice(0, 10),
      asOf: new Date().toISOString(),
    }, cors);
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
