// Pure per-provider guard: a circuit breaker plus a daily call quota. State is
// persisted in public.collector_state by the Edge Functions.

export interface GuardState {
  consecutiveFailures: number;
  openUntil: string | null;
  callsToday: number;
  callsDay: string; // YYYY-MM-DD (UTC)
}

export interface GuardConfig {
  maxFailures: number;
  openMs: number;
  dailyQuota: number;
}

export const DEFAULT_GUARD: GuardConfig = {
  maxFailures: 3,
  openMs: 6 * 60 * 60 * 1000,
  dailyQuota: 200,
};

export const freshState = (now: Date): GuardState => ({
  consecutiveFailures: 0,
  openUntil: null,
  callsToday: 0,
  callsDay: now.toISOString().slice(0, 10),
});

function rolled(state: GuardState, now: Date): GuardState {
  const day = now.toISOString().slice(0, 10);
  return state.callsDay === day
    ? state
    : { ...state, callsToday: 0, callsDay: day };
}

export function checkGuard(
  state: GuardState,
  now: Date,
  cfg: GuardConfig = DEFAULT_GUARD,
):
  | { allowed: true }
  | { allowed: false; reason: "circuit_open" | "quota_exhausted" } {
  const s = rolled(state, now);
  if (s.openUntil && new Date(s.openUntil).getTime() > now.getTime()) {
    return { allowed: false, reason: "circuit_open" };
  }
  if (s.callsToday >= cfg.dailyQuota) {
    return { allowed: false, reason: "quota_exhausted" };
  }
  return { allowed: true };
}

/** Count one outbound call against the quota. */
export function recordCall(state: GuardState, now: Date): GuardState {
  const s = rolled(state, now);
  return { ...s, callsToday: s.callsToday + 1 };
}

export function recordSuccess(state: GuardState): GuardState {
  return { ...state, consecutiveFailures: 0, openUntil: null };
}

export function recordFailure(
  state: GuardState,
  now: Date,
  cfg: GuardConfig = DEFAULT_GUARD,
): GuardState {
  const failures = state.consecutiveFailures + 1;
  return {
    ...state,
    consecutiveFailures: failures,
    openUntil:
      failures >= cfg.maxFailures
        ? new Date(now.getTime() + cfg.openMs).toISOString()
        : state.openUntil,
  };
}
