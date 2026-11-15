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
import { fetchAllRows, serveIntel } from "../_shared/intel-common.ts";
import { judgeOutcome, type PageWindow } from "../_shared/outcome.ts";

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
      const rows = await fetchAllRows<{
        page: string;
        metric_date: string;
        clicks: number;
      }>((from, to) =>
        admin
          .from("search_page_daily")
          .select("page, metric_date, clicks")
          .eq("site_id", siteId)
          .eq("engine", "google")
          .gte("metric_date", prevStart)
          .lte("metric_date", through)
          .order("metric_date")
          .order("page")
          .range(from, to),
      );
      const agg = new Map<string, PageTrend>();
      for (const r of rows) {
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

    const nowIso = new Date().toISOString();
    const { data: existing } = await admin
      .from("opportunities")
      .select("id, dedupe_key, status")
      .eq("site_id", siteId);
    const known = new Map(
      (existing ?? []).map((r) => [r.dedupe_key as string, r]),
    );

    // New findings are inserted; existing rows only get their evidence
    // refreshed, so a validated priority, classification or owner decision is
    // never overwritten by the nightly rebuild.
    const fresh = opps.filter((o) => !known.has(o.dedupeKey));
    if (fresh.length) {
      const { data: inserted, error: insErr } = await admin
        .from("opportunities")
        .insert(
          fresh.map((o) => ({
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
            original_priority: o.priority,
            requires_publish_approval: o.requiresPublishApproval,
            last_seen_at: nowIso,
          })),
        )
        .select("id");
      if (insErr) throw insErr;
      upserted += inserted?.length ?? 0;
      if (inserted?.length) {
        await admin.from("opportunity_events").insert(
          inserted.map((r) => ({
            opportunity_id: r.id,
            actor: "system",
            from_status: null,
            to_status: "new",
            note: "Created by the opportunities builder",
          })),
        );
      }
    }
    for (const o of opps) {
      const row = known.get(o.dedupeKey);
      if (!row) continue;
      await admin
        .from("opportunities")
        .update({
          problem: o.problem,
          evidence: o.evidence,
          evidence_at: o.evidenceAt,
          last_seen_at: nowIso,
        })
        .eq("id", row.id);
      upserted += 1;
    }

    // A problem that returns after being auto-resolved reopens as New. Only
    // rows the builder itself moved to Monitoring are reopened.
    const resolvedIds = opps
      .map((o) => known.get(o.dedupeKey))
      .filter((r) => r && r.status === "monitoring")
      .map((r) => r!.id as string);
    if (resolvedIds.length) {
      const { data: evs } = await admin
        .from("opportunity_events")
        .select("opportunity_id, note, at")
        .in("opportunity_id", resolvedIds)
        .order("at", { ascending: false });
      const latest = new Map<string, string>();
      for (const e of evs ?? []) {
        if (!latest.has(e.opportunity_id))
          latest.set(e.opportunity_id, e.note ?? "");
      }
      for (const id of resolvedIds) {
        if ((latest.get(id) ?? "").startsWith("Evidence no longer present")) {
          await admin
            .from("opportunities")
            .update({
              status: "new",
              status_note: "Problem reappeared in the latest evidence",
            })
            .eq("id", id);
        }
      }
    }

    // Open items the builder no longer produces: the evidence is gone, so move
    // them to Monitoring (reversible, recorded in the history).
    const keep = new Set(opps.map((o) => o.dedupeKey));
    const gone = (existing ?? []).filter(
      (r) => ["new", "validated"].includes(r.status) && !keep.has(r.dedupe_key),
    );
    for (const r of gone) {
      await admin
        .from("opportunities")
        .update({
          status: "monitoring",
          status_note: "Evidence no longer present in the latest data",
        })
        .eq("id", r.id);
      closed += 1;
    }
  }

  // Outcome measurement: for items the owner marked Implemented (now or
  // earlier, possibly since moved to Monitoring), compare the page's current
  // 28 days of Search Console data with the baseline captured before the
  // change. Only the page's own first-party numbers; no AI, no estimates.
  let measured = 0;
  const measuredAt = new Date().toISOString();
  const { data: impl } = await admin
    .from("opportunities")
    .select("id, site_id, baseline, after_metrics")
    .in("status", ["implemented", "monitoring"])
    .not("baseline", "is", null);
  for (const o of impl ?? []) {
    const base = o.baseline as (PageWindow & { url?: string }) | null;
    if (!base?.url) continue;
    const { data: evs } = await admin
      .from("opportunity_events")
      .select("at")
      .eq("opportunity_id", o.id)
      .eq("to_status", "implemented")
      .order("at", { ascending: false })
      .limit(1);
    const changedAt = evs?.[0]?.at as string | undefined;
    if (!changedAt) continue;
    const { data: last } = await admin
      .from("search_page_daily")
      .select("metric_date")
      .eq("site_id", o.site_id)
      .eq("engine", "google")
      .order("metric_date", { ascending: false })
      .limit(1);
    const through = last?.[0]?.metric_date as string | undefined;
    if (!through) continue;
    const start = isoDate(
      new Date(new Date(`${through}T00:00:00Z`).getTime() - 27 * DAY),
    );
    const { data: rows } = await admin
      .from("search_page_daily")
      .select("clicks, impressions, average_position")
      .eq("site_id", o.site_id)
      .eq("engine", "google")
      .eq("page", base.url)
      .gte("metric_date", start)
      .lte("metric_date", through)
      .limit(500);
    let clicks = 0;
    let imps = 0;
    let weighted = 0;
    let w = 0;
    for (const r of rows ?? []) {
      const i = Number(r.impressions);
      clicks += Number(r.clicks);
      imps += i;
      if (r.average_position != null && i > 0) {
        weighted += Number(r.average_position) * i;
        w += i;
      }
    }
    const after: PageWindow = {
      clicks,
      impressions: imps,
      position: w > 0 ? Math.round((weighted / w) * 10) / 10 : null,
    };
    // Days of data since the change, not wall-clock days: Search Console lags.
    const days = Math.max(
      0,
      Math.floor(
        (new Date(`${through}T00:00:00Z`).getTime() -
          new Date(changedAt).getTime()) /
          DAY,
      ),
    );
    const verdict = judgeOutcome(base, after, days);
    await admin
      .from("opportunities")
      .update({
        after_metrics: {
          capturedAt: measuredAt,
          source: "gsc",
          window: "last 28 days of data",
          dataThrough: through,
          url: base.url,
          ...after,
          verdict: verdict.verdict,
          reason: verdict.reason,
          daysSinceChange: days,
        },
      })
      .eq("id", o.id);
    measured += 1;
  }
  return { trigger, sites: sites?.length ?? 0, upserted, closed, measured };
});
