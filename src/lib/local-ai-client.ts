// Browser side of the local AI endpoints served by scripts/serve-local.mjs.
// These talk only to this PC's own dashboard server, which talks only to
// Ollama on loopback. No external inference and no paid API is involved.

export interface LocalAiStatus {
  available: boolean;
  model?: string;
  remainingToday?: number;
  reason?: string;
}

export interface LocalAiResult {
  ok: boolean;
  text?: string;
  model?: string;
  cached?: boolean;
  error?: string;
  message?: string;
}

const HEADERS = { "x-ninja-local": "1", "Content-Type": "application/json" };

export async function getLocalAiStatus(): Promise<LocalAiStatus> {
  try {
    const r = await fetch("/local-ai/status", { headers: HEADERS });
    if (!r.ok) {
      return {
        available: false,
        reason: "The local AI service is not part of this deployment.",
      };
    }
    return (await r.json()) as LocalAiStatus;
  } catch {
    return { available: false, reason: "The local AI service did not answer." };
  }
}

export const LOCAL_AI_ERRORS: Record<string, string> = {
  daily_budget_reached:
    "The local AI limit for today has been reached. It resets tomorrow.",
  site_budget_reached:
    "This site has used its local AI allowance for today. It resets tomorrow.",
  busy: "The local AI is already writing something. Try again in a moment.",
  unavailable: "The local AI model is not available right now.",
  model_failed: "The local AI model did not produce an answer.",
  evidence_too_large: "There is too much data to summarise at once.",
};

export async function explainLocally(args: {
  kind: "portfolio" | "site-plan";
  siteKey?: string;
  evidence: unknown;
}): Promise<LocalAiResult> {
  try {
    const r = await fetch("/local-ai/explain", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(args),
    });
    return (await r.json()) as LocalAiResult;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
