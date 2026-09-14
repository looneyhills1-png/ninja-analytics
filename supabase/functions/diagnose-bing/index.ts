// TEMPORARY diagnostic: audits the live Bing Webmaster integration end to
// end using the SAME BING_WEBMASTER_API_KEY project secret the real
// scheduled-sync-bing/manual-sync adapters use. Never echoes the raw key -
// only a sha256 fingerprint + last 4 characters. Writes its full report to
// public.bing_diagnostic_runs (service-role only) rather than relying on
// net._http_response, so the whole payload is easy to query back out.
//
// Checks, in order:
//   1. GetUserSites - every site this exact credential can access.
//   2. Compares Bing's own returned URL(s) against sites.bing_site_url -
//      never assumes the configured value is what Bing actually returns.
//   3. Uses Bing's own returned URL (not the configured one) for every
//      subsequent call.
//   4. GetRankAndTrafficStats (what the real adapter uses), GetQueryStats,
//      GetPageStats, GetCrawlStats - raw status/headers/schema/count/sample
//      for each, plus a check for an error embedded in a 200 response body.

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAutomationSecret } from "../_shared/auth.ts";
import { createAdminClient } from "../_shared/database.ts";
import { normalizeError } from "../_shared/errors.ts";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function keyFingerprint(key: string) {
  return sha256Hex(key).then((full) => ({
    sha256_12: full.slice(0, 12),
    last4: key.slice(-4),
    length: key.length,
  }));
}

interface EndpointResult {
  endpoint: string;
  url_no_key: string;
  http_status: number;
  ok: boolean;
  headers: Record<string, string>;
  body_top_level_keys: string[];
  d_is_array: boolean;
  record_count: number | null;
  embedded_error_detected: boolean;
  embedded_error_fields: Record<string, unknown> | null;
  sample_row: unknown;
  raw_body_excerpt: string;
  /** Full parsed `d` array, untruncated - for callers that need every row
   * (e.g. matching site identity), not just the archived excerpt/sample. */
  d_full: unknown[] | null;
}

async function callBing(
  endpoint: string,
  apiKey: string,
  params: Record<string, string> = {},
): Promise<EndpointResult> {
  const qs = new URLSearchParams({ apikey: apiKey, ...params });
  const url = `${BASE}/${endpoint}?${qs.toString()}`;
  const urlNoKey = `${BASE}/${endpoint}?${new URLSearchParams(params).toString()}`;

  const safeHeaderNames = [
    "content-type",
    "content-length",
    "date",
    "x-ms-request-id",
    "server",
  ];

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    return {
      endpoint,
      url_no_key: urlNoKey,
      http_status: 0,
      ok: false,
      headers: {},
      body_top_level_keys: [],
      d_is_array: false,
      record_count: null,
      embedded_error_detected: true,
      embedded_error_fields: { networkError: normalizeError(err).message },
      sample_row: null,
      raw_body_excerpt: "",
      d_full: null,
    };
  }

  const headers: Record<string, string> = {};
  for (const name of safeHeaderNames) {
    const v = res.headers.get(name);
    if (v) headers[name] = v;
  }

  const bodyText = await res.text();
  let parsed: unknown = null;
  let parseError: string | null = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch (e) {
    parseError = (e as Error).message;
  }

  const topLevelKeys =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>)
      : [];

  const dValue =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).d
      : undefined;
  const dIsArray = Array.isArray(dValue);

  // Bing's legacy JSON-RPC-style API can return HTTP 200 with an error
  // description instead of (or alongside) `d`. Anything beyond the plain
  // {"d": [...]} shape, or a null/missing `d` on a 200, is suspicious.
  const errorLikeKeys = topLevelKeys.filter(
    (k) => k.toLowerCase() !== "d" && k.toLowerCase() !== "__type",
  );
  const embeddedErrorDetected =
    parseError !== null ||
    errorLikeKeys.length > 0 ||
    (res.ok && dValue === undefined) ||
    (res.ok && dValue === null);

  const embeddedErrorFields: Record<string, unknown> | null =
    embeddedErrorDetected
      ? {
          parseError,
          nonDataKeys: errorLikeKeys.length
            ? Object.fromEntries(
                errorLikeKeys.map((k) => [
                  k,
                  (parsed as Record<string, unknown>)[k],
                ]),
              )
            : undefined,
          dMissingOrNull: res.ok && (dValue === undefined || dValue === null),
        }
      : null;

  return {
    endpoint,
    url_no_key: urlNoKey,
    http_status: res.status,
    ok: res.ok,
    headers,
    body_top_level_keys: topLevelKeys,
    d_is_array: dIsArray,
    record_count: dIsArray ? (dValue as unknown[]).length : null,
    embedded_error_detected: embeddedErrorDetected,
    embedded_error_fields: embeddedErrorFields,
    sample_row: dIsArray ? ((dValue as unknown[])[0] ?? null) : null,
    raw_body_excerpt: bodyText.slice(0, 2000),
    d_full: dIsArray ? (dValue as unknown[]) : null,
  };
}

function normalizeSiteUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    requireAutomationSecret(req);

    const apiKey = Deno.env.get("BING_WEBMASTER_API_KEY");
    if (!apiKey) {
      return json(
        200,
        {
          ok: false,
          state: "configuration_unverified",
          reason: "BING_WEBMASTER_API_KEY not set",
        },
        cors,
      );
    }

    const fingerprint = await keyFingerprint(apiKey);
    const admin = createAdminClient();

    const { data: sites, error: sitesError } = await admin
      .from("sites")
      .select("id, name, domain, bing_site_url")
      .ilike("domain", "%ninjatickets%");
    if (sitesError) throw sitesError;
    const site = (sites ?? [])[0] ?? null;
    const configuredBingSiteUrl: string | null = site?.bing_site_url ?? null;

    // 1. Site discovery - every site this exact credential can access.
    const userSitesResult = await callBing("GetUserSites", apiKey);
    const bingSites: Array<Record<string, unknown>> =
      (userSitesResult.d_full as Array<Record<string, unknown>> | null) ?? [];

    const bingSiteUrls = bingSites
      .map((s) => (typeof s?.Url === "string" ? s.Url : null))
      .filter((u): u is string => !!u);

    const configuredNormalized = configuredBingSiteUrl
      ? normalizeSiteUrl(configuredBingSiteUrl)
      : null;
    const matchedBingSite =
      bingSites.find(
        (s) =>
          typeof s?.Url === "string" &&
          configuredNormalized !== null &&
          normalizeSiteUrl(s.Url) === configuredNormalized,
      ) ?? null;
    const exactBingSiteUrl =
      (matchedBingSite?.Url as string | undefined) ?? null;

    const siteAccessVerified = !!matchedBingSite;
    const effectiveSiteUrl = exactBingSiteUrl ?? configuredBingSiteUrl;

    const endpointResults: EndpointResult[] = [];
    if (effectiveSiteUrl) {
      endpointResults.push(
        await callBing("GetRankAndTrafficStats", apiKey, {
          siteUrl: effectiveSiteUrl,
        }),
      );
      endpointResults.push(
        await callBing("GetQueryStats", apiKey, { siteUrl: effectiveSiteUrl }),
      );
      endpointResults.push(
        await callBing("GetPageStats", apiKey, { siteUrl: effectiveSiteUrl }),
      );
      endpointResults.push(
        await callBing("GetCrawlStats", apiKey, { siteUrl: effectiveSiteUrl }),
      );
      endpointResults.push(
        await callBing("GetCrawlIssues", apiKey, { siteUrl: effectiveSiteUrl }),
      );
    }

    const state = !userSitesResult.ok
      ? "configuration_unverified"
      : !siteAccessVerified
        ? "configuration_unverified"
        : endpointResults.some((r) => r.embedded_error_detected)
          ? "configuration_unverified"
          : endpointResults.every((r) => (r.record_count ?? 0) === 0)
            ? "connected_no_performance_data"
            : "connected_with_data";

    const report = {
      generatedAt: new Date().toISOString(),
      credential: fingerprint,
      dbConfiguredSite: {
        siteId: site?.id ?? null,
        domain: site?.domain ?? null,
        bing_site_url: configuredBingSiteUrl,
      },
      getUserSites: {
        http_status: userSitesResult.http_status,
        ok: userSitesResult.ok,
        headers: userSitesResult.headers,
        embedded_error_detected: userSitesResult.embedded_error_detected,
        embedded_error_fields: userSitesResult.embedded_error_fields,
        siteCount: bingSites.length,
        siteUrls: bingSiteUrls,
        rawSample: bingSites.slice(0, 5),
      },
      siteIdentity: {
        configuredBingSiteUrl,
        exactBingSiteUrl,
        siteAccessVerified,
        matchedBingSiteRecord: matchedBingSite,
        effectiveSiteUrlUsedForQueries: effectiveSiteUrl,
      },
      endpoints: endpointResults,
      state,
    };

    const { error: insertError } = await admin
      .from("bing_diagnostic_runs")
      .insert({ report });
    if (insertError) throw insertError;

    return json(200, { ok: true, state, siteAccessVerified }, cors);
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
