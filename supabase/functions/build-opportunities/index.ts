// build-opportunities: merges first-party evidence already in the database
// (URL Inspection, GSC page trends, latest AI-readiness run, NEURONwriter
// analyses) into one prioritised queue. Database reads and upserts only: no
// outbound calls. Owner-dismissed or done rows are never reopened.

import {
  opportunitiesFromDecline,
  opportunitiesFromInspections,
  opportunitiesFromNeuron,
  opportunitiesFromReadiness,
  type Opportunity,
  type PageTrend,
} from "../_shared/opportunities.ts";
import { serveIntel } from "../_shared/intel-common.ts";

const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

serveIntel(async ({ admin, trigger }) => {
  const { data: sites, error } = await admin
    .from("sites")
    .select("id")
    .eq("is_active", true);
  if (error) throw error;

  let upserted = 0;
  let closed = 0;
  for (const { id: siteId } of sites ?? []) {
    const opps: Opportunity[] = [];

    // Indexing failures (Google URL Inspection, first-party).
    const { data: insp } = await admin
      .from("url_inspections")
      .select("url, verdict, coverage_state, last_inspected_at")
      .eq("site_id", siteId);
    opps.push(
      ...opportunitiesFromInspections(
        siteId,
        (insp ?? []).map((r) => ({
          url: r.url,
          verdict: r.verdict,
          coverageState: r.coverage_state,
          lastInspectedAt: r.last_inspected_at,
        })),
      ),
    );

    // Declining pages: last 28 days of data vs the 28 before (GSC web rows).
    const { data: last } = await admin
      .from("search_page_daily")
      .select("metric_date")
      .eq("site_id", siteId)
      .eq("engine", "google")
      .order("metric_date", { ascending: false })
      .limit(1);
    const through = last?.[0]?.metric_date as string | undefined;
    if (through) {
      const end = new Date(`${through}T00:00:00Z`);
      const midStart = isoDate(new Date(end.getTime() - 27 * DAY));
      const prevStart = isoDate(new Date(end.getTime() - 55 * DAY));
      const { data: rows } = await admin
        .from("search_page_daily")
        .select("page, metric_date, clicks")
        .eq("site_id", siteId)
        .eq("engine", "google")
        .gte("metric_date", prevStart)
        .lte("metric_date", through)
        .limit(50_000);
      const agg = new Map<string, PageTrend>();
      for (const r of rows ?? []) {
        const t = agg.get(r.page) ?? {
          page: r.page,
          clicksRecent: 0,
          clicksPrevious: 0,
          dataThrough: through,
        };
        if (r.metric_date >= midStart) t.clicksRecent += Number(r.clicks);
        else t.clicksPrevious += Number(r.clicks);
        agg.set(r.page, t);
      }
      opps.push(...opportunitiesFromDecline(siteId, [...agg.values()]));
    }

    // Latest completed AI-readiness run.
    const { data: run } = await admin
      .from("ai_readiness_runs")
      .select("id")
      .eq("site_id", siteId)
      .in("status", ["success", "partial"])
      .order("started_at", { ascending: false })
      .limit(1);
    if (run?.[0]) {
      const { data: findings } = await admin
        .from("ai_readiness_findings")
        .select("check_key, severity, url, message, checked_at")
        .eq("run_id", run[0].id)
        .neq("severity", "ok");
      opps.push(
        ...opportunitiesFromReadiness(
          siteId,
          (findings ?? []).map((f) => ({
            checkKey: f.check_key,
            severity: f.severity,
            url: f.url,
            message: f.message,
            checkedAt: f.checked_at,
          })),
        ),
      );
    }

    // NEURONwriter analyses already fetched.
    const { data: an } = await admin
      .from("neuron_analyses")
      .select("neuron_query_id, keyword, status, questions, fetched_at")
      .eq("site_id", siteId);
    opps.push(
      ...opportunitiesFromNeuron(
        siteId,
        (an ?? []).map((a) => ({
          neuronQueryId: a.neuron_query_id,
          keyword: a.keyword,
          status: a.status,
          questions: (a.questions as string[]) ?? [],
          fetchedAt: a.fetched_at,
        })),
      ),
    );

    if (opps.length) {
      // The payload omits `status`, so a conflict keeps dismissed/done rows.
      const { error: upErr } = await admin.from("opportunities").upsert(
        opps.map((o) => ({
          site_id: o.siteId,
          dedupe_key: o.dedupeKey,
          source: o.source,
          kind: o.kind,
          target_url: o.targetUrl,
          title: o.title,
          problem: o.problem,
          evidence: o.evidence,
          evidence_at: o.evidenceAt,
          proposal: o.proposal,
          expected_impact: o.expectedImpact,
          effort: o.effort,
          priority: o.priority,
          requires_publish_approval: o.requiresPublishApproval,
          last_seen_at: new Date().toISOString(),
        })),
        { onConflict: "site_id,dedupe_key" },
      );
      if (upErr) throw upErr;
      upserted += opps.length;
      // A problem that came back reopens an auto-resolved row (never a
      // dismissed or owner-completed one).
      await admin
        .from("opportunities")
        .update({ status: "open" })
        .eq("site_id", siteId)
        .eq("status", "resolved")
        .in(
          "dedupe_key",
          opps.map((o) => o.dedupeKey),
        );
    }

    // Close open rows this rebuild no longer produces (problem resolved).
    const keep = new Set(opps.map((o) => o.dedupeKey));
    const { data: open } = await admin
      .from("opportunities")
      .select("id, dedupe_key")
      .eq("site_id", siteId)
      .eq("status", "open")
      .in("source", ["gsc", "ai_readiness", "neuronwriter"]);
    const stale = (open ?? [])
      .filter((r) => !keep.has(r.dedupe_key))
      .map((r) => r.id);
    if (stale.length) {
      await admin
        .from("opportunities")
        .update({ status: "resolved" })
        .in("id", stale);
      closed += stale.length;
    }
  }
  return { trigger, sites: sites?.length ?? 0, upserted, closed };
});
