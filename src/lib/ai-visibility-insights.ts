// AI Visibility (CLAUDE.md Phase 8 + "AI Search source coverage"). Pure
// computation over prompts/observations the browser already fetched. Every
// row here is either:
//   - an "observed" prompt: a real query taken from GSC data (a query a
//     real person actually typed into Google), or
//   - a "generated" prompt: a candidate opportunity this app synthesised
//     from that data, never claimed to be a real user prompt.
// Observations are always manual/on-demand test results (see
// src/lib/ai-search-sources.ts for why - none of these platforms expose a
// free per-site prompt/citation API) except where noted otherwise in the UI.

import { AI_SOURCES, type AiVisibilitySource } from "@/lib/ai-search-sources";

export type PromptCategory = "observed" | "generated";

export interface AiVisibilityPromptRow {
  id: string;
  siteId: string;
  promptText: string;
  category: PromptCategory;
  sourceQuery: string | null;
  createdAt: string;
}

export interface AiVisibilityObservationRow {
  id: string;
  siteId: string;
  promptId: string | null;
  promptText: string;
  source: AiVisibilitySource;
  observedAt: string;
  isCited: boolean | null;
  citedUrl: string | null;
  competitorDomain: string | null;
  country: string | null;
  device: "desktop" | "mobile" | null;
  notes: string | null;
}

export interface SourceCoverageStat {
  source: AiVisibilitySource;
  observationCount: number;
  citedCount: number;
  /** null when no observation for this source has recorded a yes/no citation
   * answer yet - never shown as 0% in that case. */
  citationRate: number | null;
  lastObservedAt: string | null;
}

/** One row per known AI source (see ai-search-sources.ts), even ones with
 * zero observations yet - so the coverage matrix always shows the full list
 * CLAUDE.md names, not just the ones already tested. */
export function computeSourceCoverage(
  observations: AiVisibilityObservationRow[],
): SourceCoverageStat[] {
  const bySource = new Map<AiVisibilitySource, AiVisibilityObservationRow[]>();
  for (const obs of observations) {
    const list = bySource.get(obs.source) ?? [];
    list.push(obs);
    bySource.set(obs.source, list);
  }

  return AI_SOURCES.map(({ source }) => {
    const rows = bySource.get(source) ?? [];
    const decided = rows.filter((r) => r.isCited != null);
    const cited = decided.filter((r) => r.isCited === true);
    const lastObservedAt = rows.reduce<string | null>(
      (max, r) => (max == null || r.observedAt > max ? r.observedAt : max),
      null,
    );
    return {
      source,
      observationCount: rows.length,
      citedCount: cited.length,
      citationRate: decided.length > 0 ? cited.length / decided.length : null,
      lastObservedAt,
    };
  });
}

export interface PromptStatus {
  prompt: AiVisibilityPromptRow;
  observations: AiVisibilityObservationRow[]; // newest first
  sourcesCovered: AiVisibilitySource[];
  lastObservedAt: string | null;
}

/** Groups observations under their prompt (falling back to a text match for
 * observations recorded before a prompt row existed, or after its prompt
 * was deleted - prompt_id is ON DELETE SET NULL, never cascaded). */
export function computePromptStatuses(
  prompts: AiVisibilityPromptRow[],
  observations: AiVisibilityObservationRow[],
): PromptStatus[] {
  const byPromptId = new Map<string, AiVisibilityObservationRow[]>();
  const byText = new Map<string, AiVisibilityObservationRow[]>();
  for (const obs of observations) {
    if (obs.promptId) {
      const list = byPromptId.get(obs.promptId) ?? [];
      list.push(obs);
      byPromptId.set(obs.promptId, list);
    } else {
      const list = byText.get(obs.promptText) ?? [];
      list.push(obs);
      byText.set(obs.promptText, list);
    }
  }

  return prompts.map((prompt) => {
    const rows = [
      ...(byPromptId.get(prompt.id) ?? []),
      ...(byText.get(prompt.promptText) ?? []),
    ].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1));

    return {
      prompt,
      observations: rows,
      sourcesCovered: [...new Set(rows.map((r) => r.source))],
      lastObservedAt: rows[0]?.observedAt ?? null,
    };
  });
}

function cleanQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export interface GeneratedPromptSuggestion {
  promptText: string;
  sourceQuery: string;
}

/**
 * Candidate AI-assistant prompts synthesised from the site's own top GSC
 * queries by query, using a few natural phrasings - clearly "generated"
 * opportunities the admin can choose to test, never a claim that anyone
 * actually typed these into an AI assistant.
 */
export function generatePromptSuggestions(
  topQueries: { query: string; impressions: number }[],
  limit = 10,
): GeneratedPromptSuggestion[] {
  const ranked = [...topQueries]
    .filter((q) => q.query.trim().length > 0)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);

  return ranked.map(({ query }) => {
    const q = cleanQuery(query);
    const isQuestionShaped =
      /^(who|what|when|where|why|how|is|are|can|does)\b/i.test(q);
    const promptText = isQuestionShaped
      ? `${q}?`
      : `What is the best option for ${q}?`;
    return { promptText, sourceQuery: q };
  });
}
