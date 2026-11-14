// ai-referrals-sync: measured visits that arrived from AI assistants, taken
// from the existing GA4 properties (sessionSource). One GA4 request per site.
// These are referral SESSIONS, not impressions, citations or share of voice.
// Reuses the stack's existing Google OAuth grant; if that grant is dead the
// circuit breaker records the failure and the dashboard shows it as such.

import { getGoogleAccessToken } from "../_shared/google-auth.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import {
  aggregateAiReferrals,
  AI_REFERRERS,
  type Ga4SourceRow,
} from "../_shared/ai-referrals.ts";
import {
  checkGuard,
  loadGuard,
  recordCall,
  recordFailure,
  recordSuccess,
  saveGuard,
  serveIntel,
} from "../_shared/intel-common.ts";

const PROVIDER = "ga4-ai-referrals";
const GUARD = { maxFailures: 3, openMs: 6 * 3_600_000, dailyQuota: 30 };

// Loose GA4-side prefilter; exact classification happens locally.
const FILTER_TOKENS = [
  "chatgpt",
  "openai",
  "perplexity",
  "gemini.google",
  "bard.google",
  "copilot.microsoft",
  "copilot.cloud",
  "claude.ai",
  "you.com",
  "phind",
  "duck.ai",
  "leo.brave",
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

serveIntel(async ({ admin, trigger, body }) => {
  const days = Math.min(Math.max(Number(body.days) || 28, 1), 90);
  const now = new Date();
  let guard = await loadGuard(admin, PROVIDER, now);
  const gate = checkGuard(guard, now, GUARD);
  if (!gate.allowed) return { trigger, skipped: gate.reason };

  const { data: sites, error } = await admin
    .from("sites")
    .select("id, ga4_property_id")
    .eq("is_active", true)
    .not("ga4_property_id", "is", null);
  if (error) throw error;

  const end = new Date(now.getTime() - 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const results: Array<Record<string, unknown>> = [];

  try {
    const token = await getGoogleAccessToken();
    for (const site of sites ?? []) {
      guard = recordCall(guard, new Date());
      const res = await fetchWithRetry(
        `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(
          site.ga4_property_id,
        )}:runReport`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: ymd(start), endDate: ymd(end) }],
            dimensions: [{ name: "date" }, { name: "sessionSource" }],
            metrics: [
              { name: "sessions" },
              { name: "activeUsers" },
              { name: "screenPageViews" },
            ],
            dimensionFilter: {
              orGroup: {
                expressions: FILTER_TOKENS.map((t) => ({
                  filter: {
                    fieldName: "sessionSource",
                    stringFilter: { matchType: "CONTAINS", value: t },
                  },
                })),
              },
            },
            limit: 10_000,
          }),
        },
        { maxRetries: 2 },
      );
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`GA4 HTTP ${res.status}`);
      }
      const report = (await res.json()) as {
        rows?: Array<{
          dimensionValues?: Array<{ value?: string }>;
          metricValues?: Array<{ value?: string }>;
        }>;
      };
      const rows: Ga4SourceRow[] = (report.rows ?? []).map((r) => {
        const raw = r.dimensionValues?.[0]?.value ?? "";
        return {
          date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
          source: r.dimensionValues?.[1]?.value ?? "",
          sessions: Number(r.metricValues?.[0]?.value ?? 0),
          users: Number(r.metricValues?.[1]?.value ?? 0),
          pageViews: Number(r.metricValues?.[2]?.value ?? 0),
        };
      });
      const agg = aggregateAiReferrals(rows);

      // Replace the window so a re-run never double counts.
      await admin
        .from("ga4_breakdown_daily")
        .delete()
        .eq("site_id", site.id)
        .eq("dimension", "ai_referrer")
        .gte("metric_date", ymd(start))
        .lte("metric_date", ymd(end));
      if (agg.length) {
        const { error: upErr } = await admin.from("ga4_breakdown_daily").insert(
          agg.map((a) => ({
            site_id: site.id,
            metric_date: a.date,
            dimension: "ai_referrer",
            dimension_value: a.provider,
            sessions: a.sessions,
            active_users: a.users,
            screen_page_views: a.pageViews,
          })),
        );
        if (upErr) throw upErr;
      }
      results.push({
        siteId: site.id,
        ga4Rows: rows.length,
        providerDays: agg.length,
      });
    }
    guard = recordSuccess(guard);
    await saveGuard(admin, PROVIDER, guard, now, { ok: true });
    return {
      trigger,
      range: [ymd(start), ymd(end)],
      providers: AI_REFERRERS.length,
      results,
    };
  } catch (err) {
    guard = recordFailure(guard, new Date(), GUARD);
    const message = err instanceof Error ? err.message.slice(0, 200) : "error";
    await saveGuard(admin, PROVIDER, guard, now, {
      ok: false,
      code: (err as { code?: string })?.code ?? "provider_error",
      message,
    });
    return {
      trigger,
      failed: (err as { code?: string })?.code ?? "provider_error",
      results,
    };
  }
});
