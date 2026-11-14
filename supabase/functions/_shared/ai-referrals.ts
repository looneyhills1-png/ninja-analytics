// Classifies GA4 session sources as AI-assistant referrals. These are measured
// referral sessions (a real visit that arrived from an assistant), not
// impressions or citations.

export interface AiReferrerRule {
  provider: string;
  hosts: string[];
}

export const AI_REFERRERS: AiReferrerRule[] = [
  {
    provider: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com", "openai.com"],
  },
  { provider: "Perplexity", hosts: ["perplexity.ai"] },
  { provider: "Gemini", hosts: ["gemini.google.com", "bard.google.com"] },
  {
    provider: "Copilot",
    hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft"],
  },
  { provider: "Claude", hosts: ["claude.ai"] },
  { provider: "You.com", hosts: ["you.com"] },
  { provider: "Phind", hosts: ["phind.com"] },
  { provider: "DuckDuckGo AI", hosts: ["duck.ai"] },
  { provider: "Brave Leo", hosts: ["leo.brave.com"] },
];

/** Returns the provider for a GA4 sessionSource value, or null. Matches the
 * host exactly or as a subdomain, and tolerates a leading scheme/path and the
 * `utm_source=chatgpt.com` style value ChatGPT appends. */
export function classifyAiReferrer(
  source: string | null | undefined,
): string | null {
  if (!source) return null;
  const cleaned = source
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s]/)[0];
  if (!cleaned) return null;
  for (const rule of AI_REFERRERS) {
    for (const h of rule.hosts) {
      if (cleaned === h || cleaned.endsWith(`.${h}`)) return rule.provider;
    }
  }
  return null;
}

export interface Ga4SourceRow {
  date: string; // YYYY-MM-DD
  source: string;
  sessions: number;
  users: number;
  pageViews: number;
}

export interface AiReferralRow {
  date: string;
  provider: string;
  sessions: number;
  users: number;
  pageViews: number;
}

/** Folds GA4 source rows into per-day, per-provider totals. */
export function aggregateAiReferrals(rows: Ga4SourceRow[]): AiReferralRow[] {
  const map = new Map<string, AiReferralRow>();
  for (const r of rows) {
    const provider = classifyAiReferrer(r.source);
    if (!provider) continue;
    const key = `${r.date}|${provider}`;
    const cur = map.get(key) ?? {
      date: r.date,
      provider,
      sessions: 0,
      users: 0,
      pageViews: 0,
    };
    cur.sessions += r.sessions;
    cur.users += r.users;
    cur.pageViews += r.pageViews;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) =>
    a.date === b.date
      ? a.provider.localeCompare(b.provider)
      : a.date.localeCompare(b.date),
  );
}
