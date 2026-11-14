// site-integrations: read-only provider discovery and connection tests for the
// Edit Site dialog. Admin + aal2 only. Uses the stack's existing Google OAuth
// grant and Bing API key server-side; responses contain property identifiers
// and plain status text, never tokens, keys or raw provider payloads.
//
// Bounded: discover = at most 3 provider calls, test = 1 call. No polling.

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError } from "../_shared/errors.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { getGoogleAccessToken } from "../_shared/google-auth.ts";
import { callBing } from "../_shared/bing.ts";
import {
  findMatchingBingSite,
  type BingSiteRecord,
} from "../_shared/bing-parse.ts";
import {
  parseBingSites,
  parseGa4AccountSummaries,
  parseGscSites,
  suggestForDomain,
  validateGa4PropertyId,
  validateGscProperty,
  validateBingSiteUrl,
} from "../_shared/site-integrations.ts";

type Status =
  | "ok"
  | "stale_credentials"
  | "missing_permission"
  | "api_disabled"
  | "not_found"
  | "invalid_input"
  | "not_configured"
  | "error";

interface ProviderResult {
  status: Status;
  message: string;
}

const ok = (message: string): ProviderResult => ({ status: "ok", message });

/** Map a failed Google HTTP response to an owner-actionable status. */
async function googleFailure(res: Response): Promise<ProviderResult> {
  let reason = "";
  let apiMessage = "";
  try {
    const body = (await res.json()) as {
      error?: {
        status?: string;
        message?: string;
        details?: Array<{ reason?: string }>;
      };
    };
    reason = body.error?.details?.find((d) => d.reason)?.reason ?? "";
    apiMessage = (body.error?.message ?? "").slice(0, 160);
  } catch {
    // non-JSON body
  }
  if (res.status === 401) {
    return {
      status: "stale_credentials",
      message: "Google rejected the stored credentials. Re-authorise Google.",
    };
  }
  if (
    reason === "SERVICE_DISABLED" ||
    /has not been used|is disabled/i.test(apiMessage)
  ) {
    return {
      status: "api_disabled",
      message:
        "The Google API is not enabled for the Cloud project. Enable it in Google Cloud Console (free).",
    };
  }
  if (res.status === 403) {
    return {
      status: "missing_permission",
      message:
        "The authorised Google account has no access to this property. Grant it access in Google, or choose another property.",
    };
  }
  if (res.status === 404) {
    return { status: "not_found", message: "Google reports no such property." };
  }
  return { status: "error", message: `Google returned HTTP ${res.status}.` };
}

async function googleToken(): Promise<string | ProviderResult> {
  try {
    return await getGoogleAccessToken();
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "config_missing") {
      return {
        status: "not_configured",
        message: "Google OAuth is not configured.",
      };
    }
    return {
      status: "stale_credentials",
      message: "Google rejected the stored credentials. Re-authorise Google.",
    };
  }
}

const authHeaders = (t: string) => ({ Authorization: `Bearer ${t}` });

async function discoverGsc(token: string) {
  const res = await fetchWithRetry(
    "https://www.googleapis.com/webmasters/v3/sites",
    { headers: authHeaders(token) },
    { maxRetries: 1 },
  );
  if (!res.ok) return { result: await googleFailure(res), items: [] };
  return {
    result: ok("Search Console properties listed."),
    items: parseGscSites(await res.json()),
  };
}

async function discoverGa4(token: string) {
  const res = await fetchWithRetry(
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
    { headers: authHeaders(token) },
    { maxRetries: 1 },
  );
  if (!res.ok) return { result: await googleFailure(res), items: [] };
  return {
    result: ok("Analytics properties listed."),
    items: parseGa4AccountSummaries(await res.json()),
  };
}

async function discoverBing() {
  const key = Deno.env.get("BING_WEBMASTER_API_KEY");
  if (!key) {
    return {
      result: {
        status: "not_configured",
        message: "Bing API key is not configured.",
      } as ProviderResult,
      items: [],
    };
  }
  try {
    const sites = await callBing("GetUserSites", key);
    return { result: ok("Bing sites listed."), items: parseBingSites(sites) };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return {
      result: {
        status: code === "invalid_credentials" ? "stale_credentials" : "error",
        message:
          code === "invalid_credentials"
            ? "Bing rejected the API key."
            : "Bing could not be reached.",
      } as ProviderResult,
      items: [],
    };
  }
}

async function testProvider(
  provider: string,
  value: string,
  domain: string,
): Promise<ProviderResult> {
  if (provider === "gsc") {
    const v = validateGscProperty(value, domain);
    if (!v.ok) return { status: "invalid_input", message: v.error };
    const t = await googleToken();
    if (typeof t !== "string") return t;
    const res = await fetchWithRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(value)}`,
      { headers: authHeaders(t) },
      { maxRetries: 1 },
    );
    if (!res.ok) return await googleFailure(res);
    const body = (await res.json()) as { permissionLevel?: string };
    if (body.permissionLevel === "siteUnverifiedUser") {
      return {
        status: "missing_permission",
        message:
          "The account is only an unverified user of this property, so no data is available.",
      };
    }
    return ok(`Connected (${body.permissionLevel ?? "access confirmed"}).`);
  }

  if (provider === "ga4") {
    const v = validateGa4PropertyId(value);
    if (!v.ok) return { status: "invalid_input", message: v.error };
    const t = await googleToken();
    if (typeof t !== "string") return t;
    const res = await fetchWithRetry(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(value)}:runReport`,
      {
        method: "POST",
        headers: { ...authHeaders(t), "Content-Type": "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
          metrics: [{ name: "sessions" }],
          limit: 1,
        }),
      },
      { maxRetries: 1 },
    );
    if (!res.ok) return await googleFailure(res);
    return ok("Connected: a read-only report was returned.");
  }

  if (provider === "bing") {
    const v = validateBingSiteUrl(value, domain);
    if (!v.ok) return { status: "invalid_input", message: v.error };
    const key = Deno.env.get("BING_WEBMASTER_API_KEY");
    if (!key)
      return {
        status: "not_configured",
        message: "Bing API key is not configured.",
      };
    try {
      const sites = (await callBing("GetUserSites", key)) as BingSiteRecord[];
      return findMatchingBingSite(sites, value)
        ? ok("Connected: the API key can see this site.")
        : {
            status: "not_found",
            message:
              "This Bing API key cannot see that site. Add and verify it in Bing Webmaster Tools first.",
          };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      return {
        status: code === "invalid_credentials" ? "stale_credentials" : "error",
        message:
          code === "invalid_credentials"
            ? "Bing rejected the API key."
            : "Bing could not be reached.",
      };
    }
  }
  return { status: "invalid_input", message: "Unknown provider." };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);
  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, cors);
    }
    await requireAdminMfa(req);
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const domain =
      typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";

    if (body?.action === "discover") {
      const token = await googleToken();
      const [gsc, ga4, bing] = await Promise.all([
        typeof token === "string"
          ? discoverGsc(token)
          : Promise.resolve({ result: token, items: [] }),
        typeof token === "string"
          ? discoverGa4(token)
          : Promise.resolve({ result: token, items: [] }),
        discoverBing(),
      ]);
      return json(
        200,
        {
          ok: true,
          providers: { gsc: gsc.result, ga4: ga4.result, bing: bing.result },
          candidates: { gsc: gsc.items, ga4: ga4.items, bing: bing.items },
          suggested: domain
            ? suggestForDomain(domain, gsc.items, ga4.items, bing.items)
            : null,
        },
        cors,
      );
    }

    if (body?.action === "test") {
      const provider = String(body.provider ?? "");
      const value = typeof body.value === "string" ? body.value.trim() : "";
      if (!value || !domain) {
        return json(
          200,
          {
            ok: true,
            result: {
              status: "invalid_input",
              message: "Enter an identifier first.",
            },
          },
          cors,
        );
      }
      return json(
        200,
        { ok: true, result: await testProvider(provider, value, domain) },
        cors,
      );
    }

    return json(
      400,
      { ok: false, error: "validation_error", message: "Unknown action" },
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
