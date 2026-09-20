// AI Search source coverage (CLAUDE.md "AI Search source coverage" +
// Phase 8). Static reference data, not fetched from anywhere - the
// capability level for each platform is a plain fact about what that
// platform exposes to site owners today, not something this app can
// discover by calling an API. Levels match CLAUDE.md exactly:
//   1. Direct first-party query data available
//   2. Webmaster/analytics visibility data available
//   3. Public/free API or lawful observation available
//   4. Manual/on-demand visibility test only
//   5. No reliable free access
//
// None of these platforms publish a free, per-site prompt/citation API for
// site owners as of this writing. Google is the sole partial exception
// (GSC's own search-appearance breakdown, synced in search_appearance_daily
// - see supabase/functions/_shared/gsc.ts). Everywhere else, a recorded
// manual/on-demand test (src/lib/ai-visibility-insights.ts +
// ai_visibility_observations) is the only zero-cost, honest data source.

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

export type AiSourceCapability = 1 | 2 | 3 | 4 | 5;

export interface AiSourceInfo {
  source: AiVisibilitySource;
  label: string;
  capability: AiSourceCapability;
  capabilityLabel: string;
  notes: string;
}

const CAPABILITY_LABEL: Record<AiSourceCapability, string> = {
  1: "Direct first-party query data",
  2: "Webmaster/analytics visibility data",
  3: "Public/free API or lawful observation",
  4: "Manual/on-demand visibility test only",
  5: "No reliable free access",
};

export const AI_SOURCES: AiSourceInfo[] = [
  {
    source: "gemini",
    label: "Google Gemini / AI Mode / AI Overviews",
    capability: 2,
    capabilityLabel: CAPABILITY_LABEL[2],
    notes:
      "Google Search Console exposes a search-appearance breakdown that can include AI-feature impressions (synced into search_appearance_daily) - the one platform here with any webmaster-exposed data. It does not expose exact prompt text or citation detail, so it's supplemented with manual checks.",
  },
  {
    source: "copilot",
    label: "Microsoft Copilot / Bing AI",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "Bing Webmaster Tools reports classic Bing search performance (already synced) but does not break out Copilot/Bing-AI-answer citations separately. Manual on-demand checks are the only way to see whether a page is cited in a Copilot answer.",
  },
  {
    source: "chatgpt",
    label: "ChatGPT / OpenAI search & answers",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "OpenAI does not publish a per-site query or citation log for site owners.",
  },
  {
    source: "claude",
    label: "Anthropic Claude",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "No per-site analytics or citation log is published for site owners.",
  },
  {
    source: "siri",
    label: "Apple Siri / Apple Intelligence",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "No public webmaster tool. A manual test requires an Apple device and is inherently low-throughput.",
  },
  {
    source: "alexa",
    label: "Amazon Alexa",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "No public analytics for site owners. A manual test requires an Alexa device.",
  },
  {
    source: "yahoo",
    label: "Yahoo Search",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "Yahoo Search results are largely Bing-sourced in most regions, but Yahoo does not offer its own free webmaster console distinct from Bing's.",
  },
  {
    source: "duckduckgo",
    label: "DuckDuckGo / DuckAssist",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "No webmaster console or citation API for site owners. Its underlying results are partly Bing-sourced, but that doesn't give a DuckDuckGo-specific view.",
  },
  {
    source: "brave",
    label: "Brave Search / Answer with AI",
    capability: 3,
    capabilityLabel: CAPABILITY_LABEL[3],
    notes:
      "Brave Search offers a free-tier API (limited monthly quota) that can confirm whether a domain appears in classic Brave results for a query. The separate 'Answer with AI' summary feature isn't independently queryable, so citation-in-AI-answer still needs a manual check.",
  },
  {
    source: "ecosia",
    label: "Ecosia",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "No free API or webmaster console for site owners; results are largely Bing-sourced.",
  },
  {
    source: "dogpile",
    label: "Dogpile & other metasearch engines",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "Metasearch engines aggregate other engines' results with no dedicated API of their own.",
  },
  {
    source: "perplexity",
    label: "Perplexity",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "Perplexity's API is a paid product for building search experiences, not a free citation-tracking tool for site owners.",
  },
  {
    source: "other",
    label: "Other AI/search assistant",
    capability: 5,
    capabilityLabel: CAPABILITY_LABEL[5],
    notes:
      "Catch-all for a newly-relevant system not yet in this list - default to a manual/on-demand test until it's classified properly.",
  },
];

export const AI_SOURCE_BY_KEY = new Map(AI_SOURCES.map((s) => [s.source, s]));

export function aiSourceLabel(source: AiVisibilitySource): string {
  return AI_SOURCE_BY_KEY.get(source)?.label ?? source;
}
