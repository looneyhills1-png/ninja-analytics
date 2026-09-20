// Pure request validation for the manage-portfolio Edge Function - no Deno or
// npm imports, so it is unit-testable from Vitest (see src/test/).
//
// Server-side caps bound every table this function can write to, so a
// compromised-but-authenticated browser session cannot bloat the database.

import { isUuid, type ParseResult } from "./validate.ts";

/** Server-side row cap (enforced again by the function before insert). */
export const MAX_TRACKED_QUERIES_PER_SITE = 20;

export interface TrackedQueryInput {
  siteId: string;
  query: string;
}

export function parseTrackedQueryInput(
  body: unknown,
): ParseResult<TrackedQueryInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (!isUuid(b.siteId)) {
    return { ok: false, error: "siteId must be a valid UUID" };
  }
  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (query.length < 1 || query.length > 200) {
    return { ok: false, error: "query must be 1-200 characters" };
  }

  return { ok: true, value: { siteId: b.siteId, query } };
}

// Rank tracking (Phase 2) -----------------------------------------------------

export const MAX_TRACKED_RANK_KEYWORDS_PER_SITE = 30;
export const MAX_COMPETITOR_DOMAINS_PER_SITE = 25;
export const MAX_SERP_RESULTS_PER_OBSERVATION = 30;

export type RankEngine = "google" | "bing";
export type RankDevice = "desktop" | "mobile";

const RANK_ENGINES: RankEngine[] = ["google", "bing"];
const RANK_DEVICES: RankDevice[] = ["desktop", "mobile"];

export interface TrackedRankKeywordInput {
  siteId: string;
  query: string;
  engine: RankEngine;
  device: RankDevice;
  country: string | null;
  location: string | null;
}

function optionalTrimmedString(
  value: unknown,
  maxLen: number,
): ParseResult<string | null> {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "Expected a string or null" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > maxLen) {
    return { ok: false, error: `Must be at most ${maxLen} characters` };
  }
  return { ok: true, value: trimmed };
}

export function parseTrackedRankKeywordInput(
  body: unknown,
): ParseResult<TrackedRankKeywordInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (!isUuid(b.siteId)) {
    return { ok: false, error: "siteId must be a valid UUID" };
  }
  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (query.length < 1 || query.length > 200) {
    return { ok: false, error: "query must be 1-200 characters" };
  }
  const engine = b.engine ?? "google";
  if (
    typeof engine !== "string" ||
    !RANK_ENGINES.includes(engine as RankEngine)
  ) {
    return { ok: false, error: "engine must be google or bing" };
  }
  const device = b.device ?? "desktop";
  if (
    typeof device !== "string" ||
    !RANK_DEVICES.includes(device as RankDevice)
  ) {
    return { ok: false, error: "device must be desktop or mobile" };
  }
  const country = optionalTrimmedString(b.country, 10);
  if (!country.ok) return { ok: false, error: `country: ${country.error}` };
  const location = optionalTrimmedString(b.location, 120);
  if (!location.ok) return { ok: false, error: `location: ${location.error}` };

  return {
    ok: true,
    value: {
      siteId: b.siteId,
      query,
      engine: engine as RankEngine,
      device: device as RankDevice,
      country: country.value,
      location: location.value,
    },
  };
}

export interface RemoveTrackedRankKeywordInput {
  id: string;
}

export function parseRemoveTrackedRankKeywordInput(
  body: unknown,
): ParseResult<RemoveTrackedRankKeywordInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.id)) return { ok: false, error: "id must be a valid UUID" };
  return { ok: true, value: { id: b.id } };
}

export interface RankObservationInput {
  trackedRankKeywordId: string;
  rankingUrl: string | null;
  observedRank: number | null;
}

function parseObservedRank(value: unknown): ParseResult<number | null> {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      error: "observedRank must be a positive integer, or null if not found",
    };
  }
  if (value > 200) {
    return { ok: false, error: "observedRank must be 200 or less" };
  }
  return { ok: true, value };
}

function parseOptionalUrl(value: unknown): ParseResult<string | null> {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || value.length > 2000) {
    return { ok: false, error: "Must be a URL string of at most 2000 chars" };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "URL must be http(s)" };
    }
  } catch {
    return { ok: false, error: "Must be a valid URL" };
  }
  return { ok: true, value };
}

export function parseRankObservationInput(
  body: unknown,
): ParseResult<RankObservationInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.trackedRankKeywordId)) {
    return { ok: false, error: "trackedRankKeywordId must be a valid UUID" };
  }
  const rankingUrl = parseOptionalUrl(b.rankingUrl);
  if (!rankingUrl.ok)
    return { ok: false, error: `rankingUrl: ${rankingUrl.error}` };
  const observedRank = parseObservedRank(b.observedRank);
  if (!observedRank.ok) return observedRank;

  return {
    ok: true,
    value: {
      trackedRankKeywordId: b.trackedRankKeywordId,
      rankingUrl: rankingUrl.value,
      observedRank: observedRank.value,
    },
  };
}

export interface SerpObservationResultInput {
  domain: string;
  url: string | null;
  rankObserved: number | null;
  isOwnSite: boolean;
}

export interface SerpObservationInput {
  trackedRankKeywordId: string;
  results: SerpObservationResultInput[];
}

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

export function parseSerpObservationInput(
  body: unknown,
): ParseResult<SerpObservationInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.trackedRankKeywordId)) {
    return { ok: false, error: "trackedRankKeywordId must be a valid UUID" };
  }
  if (!Array.isArray(b.results) || b.results.length === 0) {
    return { ok: false, error: "results must be a non-empty array" };
  }
  if (b.results.length > MAX_SERP_RESULTS_PER_OBSERVATION) {
    return {
      ok: false,
      error: `results may not exceed ${MAX_SERP_RESULTS_PER_OBSERVATION} rows`,
    };
  }

  const results: SerpObservationResultInput[] = [];
  for (const raw of b.results) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Each result must be an object" };
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.domain !== "string" || r.domain.trim().length === 0) {
      return { ok: false, error: "Each result needs a domain" };
    }
    const domain = normalizeDomain(r.domain);
    if (domain.length > 253) {
      return { ok: false, error: "domain is too long" };
    }
    const url = parseOptionalUrl(r.url);
    if (!url.ok) return { ok: false, error: `url: ${url.error}` };
    const rankObserved = parseObservedRank(r.rankObserved);
    if (!rankObserved.ok) return rankObserved;
    results.push({
      domain,
      url: url.value,
      rankObserved: rankObserved.value,
      isOwnSite: r.isOwnSite === true,
    });
  }

  return {
    ok: true,
    value: { trackedRankKeywordId: b.trackedRankKeywordId, results },
  };
}

export interface CompetitorDomainInput {
  siteId: string;
  domain: string;
  label: string | null;
  note: string | null;
  autoDiscovered: boolean;
}

export function parseCompetitorDomainInput(
  body: unknown,
): ParseResult<CompetitorDomainInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.siteId)) {
    return { ok: false, error: "siteId must be a valid UUID" };
  }
  if (typeof b.domain !== "string" || b.domain.trim().length === 0) {
    return { ok: false, error: "domain is required" };
  }
  const domain = normalizeDomain(b.domain);
  if (domain.length > 253) {
    return { ok: false, error: "domain is too long" };
  }
  const label = optionalTrimmedString(b.label, 80);
  if (!label.ok) return { ok: false, error: `label: ${label.error}` };
  const note = optionalTrimmedString(b.note, 300);
  if (!note.ok) return { ok: false, error: `note: ${note.error}` };

  return {
    ok: true,
    value: {
      siteId: b.siteId,
      domain,
      label: label.value,
      note: note.value,
      autoDiscovered: b.autoDiscovered === true,
    },
  };
}

export interface RemoveCompetitorDomainInput {
  siteId: string;
  domain: string;
}

export function parseRemoveCompetitorDomainInput(
  body: unknown,
): ParseResult<RemoveCompetitorDomainInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.siteId)) {
    return { ok: false, error: "siteId must be a valid UUID" };
  }
  if (typeof b.domain !== "string" || b.domain.trim().length === 0) {
    return { ok: false, error: "domain is required" };
  }
  return {
    ok: true,
    value: { siteId: b.siteId, domain: normalizeDomain(b.domain) },
  };
}

// AI Visibility (Phase 8 / "AI Search source coverage") ----------------------

export const MAX_AI_PROMPTS_PER_SITE = 60;

export type AiPromptCategory = "observed" | "generated";
export type AiVisibilitySource =
  | "chatgpt"
  | "gemini"
  | "copilot"
  | "claude"
  | "siri"
  | "alexa"
  | "yahoo"
  | "duckduckgo"
  | "brave"
  | "ecosia"
  | "dogpile"
  | "perplexity"
  | "other";

const AI_SOURCES: AiVisibilitySource[] = [
  "chatgpt",
  "gemini",
  "copilot",
  "claude",
  "siri",
  "alexa",
  "yahoo",
  "duckduckgo",
  "brave",
  "ecosia",
  "dogpile",
  "perplexity",
  "other",
];

export interface AiPromptInput {
  siteId: string;
  promptText: string;
  category: AiPromptCategory;
  sourceQuery: string | null;
}

export function parseAiPromptInput(body: unknown): ParseResult<AiPromptInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.siteId)) {
    return { ok: false, error: "siteId must be a valid UUID" };
  }
  const promptText =
    typeof b.promptText === "string" ? b.promptText.trim() : "";
  if (promptText.length < 1 || promptText.length > 500) {
    return { ok: false, error: "promptText must be 1-500 characters" };
  }
  if (b.category !== "observed" && b.category !== "generated") {
    return { ok: false, error: "category must be observed or generated" };
  }
  const sourceQuery = optionalTrimmedString(b.sourceQuery, 200);
  if (!sourceQuery.ok) {
    return { ok: false, error: `sourceQuery: ${sourceQuery.error}` };
  }
  return {
    ok: true,
    value: {
      siteId: b.siteId,
      promptText,
      category: b.category,
      sourceQuery: sourceQuery.value,
    },
  };
}

export interface RemoveAiPromptInput {
  id: string;
}

export function parseRemoveAiPromptInput(
  body: unknown,
): ParseResult<RemoveAiPromptInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.id)) return { ok: false, error: "id must be a valid UUID" };
  return { ok: true, value: { id: b.id } };
}

export interface AiObservationInput {
  siteId: string;
  promptId: string | null;
  promptText: string;
  source: AiVisibilitySource;
  isCited: boolean | null;
  citedUrl: string | null;
  competitorDomain: string | null;
  country: string | null;
  device: "desktop" | "mobile" | null;
  notes: string | null;
}

export function parseAiObservationInput(
  body: unknown,
): ParseResult<AiObservationInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.siteId)) {
    return { ok: false, error: "siteId must be a valid UUID" };
  }
  let promptId: string | null = null;
  if (b.promptId != null) {
    if (!isUuid(b.promptId)) {
      return { ok: false, error: "promptId must be a valid UUID or null" };
    }
    promptId = b.promptId;
  }
  const promptText =
    typeof b.promptText === "string" ? b.promptText.trim() : "";
  if (promptText.length < 1 || promptText.length > 500) {
    return { ok: false, error: "promptText must be 1-500 characters" };
  }
  if (
    typeof b.source !== "string" ||
    !AI_SOURCES.includes(b.source as AiVisibilitySource)
  ) {
    return {
      ok: false,
      error: `source must be one of ${AI_SOURCES.join(", ")}`,
    };
  }
  if (b.isCited != null && typeof b.isCited !== "boolean") {
    return { ok: false, error: "isCited must be a boolean or null" };
  }
  const citedUrl = parseOptionalUrl(b.citedUrl);
  if (!citedUrl.ok) return { ok: false, error: `citedUrl: ${citedUrl.error}` };
  const competitorDomain = optionalTrimmedString(b.competitorDomain, 253);
  if (!competitorDomain.ok) {
    return { ok: false, error: `competitorDomain: ${competitorDomain.error}` };
  }
  const country = optionalTrimmedString(b.country, 10);
  if (!country.ok) return { ok: false, error: `country: ${country.error}` };
  if (b.device != null && b.device !== "desktop" && b.device !== "mobile") {
    return { ok: false, error: "device must be desktop, mobile, or null" };
  }
  const notes = optionalTrimmedString(b.notes, 500);
  if (!notes.ok) return { ok: false, error: `notes: ${notes.error}` };

  return {
    ok: true,
    value: {
      siteId: b.siteId,
      promptId,
      promptText,
      source: b.source as AiVisibilitySource,
      isCited: (b.isCited as boolean | null) ?? null,
      citedUrl: citedUrl.value,
      competitorDomain: competitorDomain.value,
      country: country.value,
      device: (b.device as "desktop" | "mobile" | null) ?? null,
      notes: notes.value,
    },
  };
}
