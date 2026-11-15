import type { Delta, InsightsResult } from "@/lib/insights";

const d = (x: Delta) => ({
  now: x.current,
  before: x.previous,
  changePct: x.pct == null ? null : Math.round(x.pct * 10) / 10,
});

/** The compact, already-computed facts handed to the local AI. Numbers only
 * come from the dashboard's own first-party data; nothing is invented here and
 * the size is capped so a briefing is always cheap. */
export function buildBriefingEvidence(
  data: InsightsResult,
  topActionTitles: string[],
) {
  return {
    periodDays: data.days,
    activeSites: data.health.activeSites,
    integrationsNeedingAttention: data.health.attention,
    totals: {
      searchClicks: d(data.kpis.clicks),
      impressions: d(data.kpis.impressions),
      activeUsers: d(data.kpis.users),
      sessions: d(data.kpis.sessions),
    },
    sites: data.sites.slice(0, 6).map((s) => ({
      name: s.siteName,
      clicks: d(s.clicks),
      impressions: d(s.impressions),
      sessions: d(s.sessions),
      averageSearchPosition: s.position,
    })),
    notices: data.insights.slice(0, 6).map((i) => ({
      severity: i.severity,
      title: i.title,
      detail: i.detail,
    })),
    topActions: topActionTitles.slice(0, 3),
  };
}
