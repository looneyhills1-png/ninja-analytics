// Fix Workflow safety/validation layer (PART 1, 2026-09-24 brief). This is
// the layer that must reject an unsupported or semantically-irrelevant
// recommendation instead of executing it - the brief's own worked example
// is a real bug already found and fixed: a suggestion to link from "Sale
// Sharks" (rugby) to Oasis's ticket page purely because both strings contain
// "sale" (see src/lib/text-tokens.ts's STOPWORDS fix, same date).
//
// v1 scope, deliberately narrow: the only fix type this layer will approve
// for automatic execution is a CTR-first meta description refresh, and only
// as a MECHANICAL recombination of two pieces of text NinjaTickets' own
// source data already contains verified (the real ranking query + the
// guide's own current meta description) - never freeform generated prose,
// so "never invent facts" holds by construction, not by hoping a generator
// behaved. Internal-link suggestions are still analysed and recorded in the
// audit trail (rejected_fixes/proposed_fixes), but never auto-executed in
// this version: guides.json has no relatedLinks-style field for them to
// write into yet (confirmed 2026-09-24) - executing them today would mean
// inventing a new schema field with no renderer, which is exactly the kind
// of scope creep CLAUDE.md warns against. That's a real, current limitation,
// stated plainly rather than worked around.

export interface EvidenceSnapshot {
  query: string;
  url: string;
  currentPosition: number | null;
  impressions: number;
  clicks: number;
  ctr: number | null;
  categories: string[];
}

// Mirrors opportunity-diagnosis.ts's isCtrFirstCase thresholds exactly (see
// that file's CTR_FIRST_MIN_IMPRESSIONS/CTR_FIRST_MAX_POSITION) - duplicated
// here because Deno edge functions don't import from src/lib/, not because
// the rule is different. Keep both in sync if either changes.
const CTR_FIRST_MIN_IMPRESSIONS = 10;
const CTR_FIRST_MAX_POSITION = 10;

export function isCtrFirstCase(e: EvidenceSnapshot): boolean {
  const rankingWell =
    e.currentPosition != null && e.currentPosition <= CTR_FIRST_MAX_POSITION;
  const hasMeaningfulImpressions = e.impressions >= CTR_FIRST_MIN_IMPRESSIONS;
  const effectivelyNoClicks = e.clicks === 0;
  return (
    e.categories.includes("high-impression-low-ctr") ||
    (rankingWell && hasMeaningfulImpressions && effectivelyNoClicks)
  );
}

export interface MetaDescriptionFix {
  type: "meta_description";
  slug: string;
  currentValue: string;
  newValue: string;
}

export interface RejectedFix {
  type: string;
  reason: string;
  detail?: Record<string, unknown>;
}

const MIN_META_LENGTH = 50;
const MAX_META_LENGTH = 160;

/**
 * Recombines the page's own real ranking query with its own real existing
 * meta description - the query leads (so the exact search term the user
 * typed is more likely to appear in the SERP snippet), the existing
 * description follows, trimmed to fit. Never invents new words. Returns
 * null when the query alone is already too long to combine safely, or the
 * result would be too short to be a real description.
 */
export function buildCtrFirstMetaDescription(
  currentValue: string,
  query: string,
): string | null {
  const q = query.trim();
  const current = currentValue.trim();
  if (!q || !current) return null;
  const lead = q.charAt(0).toUpperCase() + q.slice(1);
  const separator = ": ";
  const candidate = `${lead}${separator}${current}`;
  if (candidate.length <= MAX_META_LENGTH) {
    return candidate.length >= MIN_META_LENGTH ? candidate : null;
  }
  const budget = MAX_META_LENGTH - (lead.length + separator.length + 1); // +1 for the ellipsis char
  if (budget < 20) return null; // the query itself leaves no room to combine safely
  const trimmedDesc = current.slice(0, budget).replace(/\s+\S*$/, "");
  const result = `${lead}${separator}${trimmedDesc}…`;
  return result.length >= MIN_META_LENGTH ? result : null;
}

export interface GeneratorControlledEntry {
  slug: string;
  fields: string[];
  generator: string;
}

export interface ValidateFixPlanInput {
  evidence: EvidenceSnapshot;
  slug: string;
  currentMetaDescription: string | null;
  generatorControlled: GeneratorControlledEntry[];
}

export interface ValidateFixPlanResult {
  approved: MetaDescriptionFix[];
  rejected: RejectedFix[];
}

/**
 * The one entry point the execute-fix function calls before touching
 * anything. Every rejection carries a human-readable reason so the audit
 * trail (fix_runs.rejected_fixes) is genuinely explanatory, not just a
 * boolean.
 */
export function validateFixPlan(
  input: ValidateFixPlanInput,
): ValidateFixPlanResult {
  const { evidence, slug, currentMetaDescription, generatorControlled } = input;
  const rejected: RejectedFix[] = [];
  const approved: MetaDescriptionFix[] = [];

  if (evidence.impressions < CTR_FIRST_MIN_IMPRESSIONS) {
    rejected.push({
      type: "meta_description",
      reason: `Not enough impressions (${evidence.impressions}) to justify an automated change - below the ${CTR_FIRST_MIN_IMPRESSIONS}-impression evidence floor.`,
    });
    return { approved, rejected };
  }

  if (!isCtrFirstCase(evidence)) {
    rejected.push({
      type: "meta_description",
      reason:
        "Not a CTR-first case (either not ranking well enough, or already receiving clicks) - a meta description change isn't the evidence-supported priority action here. v1 only auto-executes CTR-first meta description refreshes.",
    });
    return { approved, rejected };
  }

  const controlEntry = generatorControlled.find((g) => g.slug === slug);
  if (controlEntry?.fields.includes("metaDescription")) {
    rejected.push({
      type: "meta_description",
      reason: `This slug's metaDescription is generator-controlled (${controlEntry.generator}) - it is overwritten every build. Editing guides.json directly would be silently clobbered. Fix the generator script instead (see 2026-09-24 Oasis CTR fix for the precedent).`,
      detail: { generator: controlEntry.generator },
    });
    return { approved, rejected };
  }

  if (currentMetaDescription == null) {
    rejected.push({
      type: "meta_description",
      reason:
        "No current metaDescription found for this slug in guides.json - nothing to refine, and inventing one from nothing is not permitted.",
    });
    return { approved, rejected };
  }

  const newValue = buildCtrFirstMetaDescription(
    currentMetaDescription,
    evidence.query,
  );
  if (!newValue) {
    rejected.push({
      type: "meta_description",
      reason:
        "Could not mechanically combine the ranking query with the current meta description within the 50-160 character safe range (query too long, or result too short) - refused rather than truncating unsafely.",
    });
    return { approved, rejected };
  }
  if (newValue === currentMetaDescription) {
    rejected.push({
      type: "meta_description",
      reason:
        "The query is already reflected in the current meta description - no change would be made.",
    });
    return { approved, rejected };
  }

  approved.push({
    type: "meta_description",
    slug,
    currentValue: currentMetaDescription,
    newValue,
  });
  return { approved, rejected };
}

// --- Internal-link relevance re-check (defense in depth) -------------------
// Mirrors src/lib/text-tokens.ts's stopword fix for the Sale Sharks/Oasis
// incident. This module never executes a link addition (see file header),
// but the Fix workflow still records whether the client-submitted
// suggestions it received would pass this server-side relevance re-check,
// so the audit trail shows the same safety reasoning that protects the
// prompt-based flow, applied here too.
const GENERIC_TERMS = new Set([
  "sale",
  "sales",
  "onsale",
  "date",
  "dates",
  "release",
  "book",
  "buy",
  "find",
  "best",
  "top",
  "tickets",
  "ticket",
  "event",
  "events",
]);

export function hasGenuineRelevance(matchedTerms: string[]): boolean {
  return matchedTerms.some(
    (t) => t.length >= 3 && !GENERIC_TERMS.has(t.toLowerCase()),
  );
}
