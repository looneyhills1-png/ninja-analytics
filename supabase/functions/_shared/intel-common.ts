// Shared plumbing for the content-intelligence / readiness / opportunities
// functions: dual authorisation (automation secret for cron, admin+aal2 for the
// dashboard) and persisted collector guards.

import { corsHeaders, preflight } from "./cors.ts";
import { requireAdminMfa, requireAutomationSecret } from "./auth.ts";
import { json } from "./response.ts";
import { normalizeError } from "./errors.ts";
import { createAdminClient, type SupabaseClient } from "./database.ts";
import {
  checkGuard,
  freshState,
  recordCall,
  recordFailure,
  recordSuccess,
  type GuardConfig,
  type GuardState,
  DEFAULT_GUARD,
} from "./collector-guard.ts";

export type Trigger = "scheduled" | "manual";

export async function authorize(req: Request): Promise<Trigger> {
  if (req.headers.get("X-Automation-Secret")) {
    requireAutomationSecret(req);
    return "scheduled";
  }
  await requireAdminMfa(req);
  return "manual";
}

/** Wraps a handler with CORS, preflight, authorisation and error mapping. */
export function serveIntel(
  handler: (ctx: {
    admin: SupabaseClient;
    trigger: Trigger;
    body: Record<string, unknown>;
  }) => Promise<unknown>,
): void {
  Deno.serve(async (req) => {
    const pre = preflight(req);
    if (pre) return pre;
    const cors = corsHeaders(req);
    try {
      const trigger = await authorize(req);
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) ?? {};
      } catch {
        // empty body is fine
      }
      const result = await handler({
        admin: createAdminClient(),
        trigger,
        body,
      });
      return json(200, { ok: true, ...(result as object) }, cors);
    } catch (err) {
      const n = normalizeError(err);
      return json(n.status ?? 500, { ok: false, error: n.code }, cors);
    }
  });
}

export async function loadGuard(
  admin: SupabaseClient,
  provider: string,
  now: Date,
): Promise<GuardState> {
  const { data } = await admin
    .from("collector_state")
    .select("consecutive_failures, open_until, calls_today, calls_day")
    .eq("provider", provider)
    .maybeSingle();
  if (!data) return freshState(now);
  return {
    consecutiveFailures: data.consecutive_failures,
    openUntil: data.open_until,
    callsToday: data.calls_today,
    callsDay: data.calls_day,
  };
}

export async function saveGuard(
  admin: SupabaseClient,
  provider: string,
  state: GuardState,
  now: Date,
  outcome: { ok: boolean; code?: string; message?: string },
): Promise<void> {
  await admin.from("collector_state").upsert({
    provider,
    consecutive_failures: state.consecutiveFailures,
    open_until: state.openUntil,
    calls_today: state.callsToday,
    calls_day: state.callsDay,
    last_attempt_at: now.toISOString(),
    ...(outcome.ok ? { last_success_at: now.toISOString() } : {}),
    last_error_code: outcome.ok ? null : (outcome.code ?? "error"),
    last_error_message: outcome.ok ? null : (outcome.message ?? null),
  });
}

export {
  checkGuard,
  recordCall,
  recordFailure,
  recordSuccess,
  DEFAULT_GUARD,
  type GuardConfig,
  type GuardState,
};
