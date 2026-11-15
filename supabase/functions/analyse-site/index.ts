// analyse-site: the read-only "Analyse & Optimise" assessment for one site.
// It only reads first-party data already in the database (latest site audit,
// the validated Fix queue, 28 days of Search Console) and writes the result to
// the optimisation audit tables. It never contacts the site, never calls an AI
// model and never publishes anything. Applying a change is a separate,
// mode-gated step (optimise-apply).
//
// Bounded: one run per site per minute (identical requests return the last
// run) and at most MAX_RUNS_PER_DAY runs per site per day.

import { fetchAllRows, serveIntel } from "../_shared/intel-common.ts";
import { SyncError } from "../_shared/errors.ts";
import {
  diagnoseUrl,
  type Diagnosis,
  type InspectionFact,
  type InventoryRow,
} from "../_shared/coverage.ts";
import {
  buildQueryFindings,
  type DeviceRow,
  type QPRow,
  type QueryFinding,
} from "../_shared/query-intel.ts";
import {
  assessSite,
  type CtrCandidate,
  type OptimiseMode,
} from "../_shared/optimise.ts";

const DAY = 86_400_000;
const MAX_RUNS_PER_DAY = 12;
const MIN_INTERVAL_MS = 60_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

serveIntel(async ({ admin, body }) => {
  const siteId = body.siteId;
  if (typeof siteId !== "string" || siteId.length === 0) {
    throw new SyncError("validation_error", "siteId is required");
  }
  const now = new Date();

  const { data: site } = await admin
    .from("sites")
    .select("id, name, domain, hosting_platform, hosting_project_id")
    .eq("id", siteId)
    .maybeSingle();
  if (!site) throw new SyncError("validation_error", "site not found");

  // Deduplicate and cap.
  const { data: recent } = await admin
    .from("optimisation_runs")
    .select("id, started_at")
    .eq("site_id", siteId)
    .gte("started_at", new Date(now.getTime() - DAY).toISOString())
    .order("started_at", { ascending: false });
  if (
    recent?.[0] &&
    now.getTime() - new Date(recent[0].started_at).getTime() < MIN_INTERVAL_MS
  ) {
    return { runId: recent[0].id, reused: true };
  }
  if ((recent?.length ?? 0) >= MAX_RUNS_PER_DAY) {
    throw new SyncError(
      "rate_limited",
      `Daily analysis limit reached (${MAX_RUNS_PER_DAY} per site).`,
    );
  }

  const { data: setting } = await admin
    .from("site_optimisation")
    .select("mode")
    .eq("site_id", siteId)
    .maybeSingle();
  const mode = (setting?.mode ?? "monitor") as OptimiseMode;

  // Latest finished site audit and its issues.
  const { data: auditRun } = await admin
    .from("site_audit_runs")
    .select("id, finished_at, pages_crawled, health_score")
    .eq("site_id", siteId)
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let issues: Array<{
    url: string | null;
    severity: "error" | "warning" | "notice";
    code: string;
    message: string;
  }> = [];
  if (auditRun) {
    const { data } = await admin
      .from("site_audit_issues")
      .select("url, severity, code, message")
      .eq("run_id", auditRun.id)
      .limit(1000);
    issues = data ?? [];
  }

  const { data: opps } = await admin
    .from("opportunities")
    .select(
      "id, status, classification, priority, title, problem, recommended_change, proposal, target_url, change_type, source",
    )
    .eq("site_id", siteId)
    .in("status", ["new", "validated", "approved"])
    .limit(300);

  const { data: lastPage } = await admin
    .from("search_page_daily")
    .select("metric_date")
    .eq("site_id", siteId)
    .eq("engine", "google")
    .order("metric_date", { ascending: false })
    .limit(1);
  const through = (lastPage?.[0]?.metric_date as string | undefined) ?? null;

  // CTR-first candidates: ranking well, plenty of impressions, no clicks.
  const ctrCandidates: CtrCandidate[] = [];
  let qpRecent: QPRow[] = [];
  let qpPrevious: QPRow[] = [];
  if (through) {
    const start = isoDate(
      new Date(new Date(`${through}T00:00:00Z`).getTime() - 55 * DAY),
    );
    const recentStart = isoDate(
      new Date(new Date(`${through}T00:00:00Z`).getTime() - 27 * DAY),
    );
    const rows = await fetchAllRows<{
      query: string;
      page: string;
      metric_date: string;
      clicks: number;
      impressions: number;
      average_position: number | null;
    }>((from, to) =>
      admin
        .from("search_query_page_daily")
        .select(
          "query, page, metric_date, clicks, impressions, average_position",
        )
        .eq("site_id", siteId)
        .eq("engine", "google")
        .gte("metric_date", start)
        .lte("metric_date", through)
        .order("metric_date")
        .order("query")
        .order("page")
        .range(from, to),
    );
    // Split the 56 days; the CTR candidates use only the most recent 28.
    const recentRows = rows.filter((r) => r.metric_date >= recentStart);
    const toQP = (list: typeof rows): QPRow[] => {
      const m = new Map<string, QPRow & { w: number }>();
      for (const r of list) {
        const k = `${r.query}\u0000${r.page}`;
        const a = m.get(k) ?? {
          query: r.query,
          page: r.page,
          clicks: 0,
          impressions: 0,
          position: null,
          w: 0,
        };
        const imp = Number(r.impressions);
        a.clicks += Number(r.clicks);
        a.impressions += imp;
        if (r.average_position != null && imp > 0) {
          a.position = (a.position ?? 0) + Number(r.average_position) * imp;
          a.w += imp;
        }
        m.set(k, a);
      }
      return [...m.values()].map((a) => ({
        query: a.query,
        page: a.page,
        clicks: a.clicks,
        impressions: a.impressions,
        position: a.w > 0 ? Math.round((a.position! / a.w) * 10) / 10 : null,
      }));
    };
    qpRecent = toQP(recentRows);
    qpPrevious = toQP(rows.filter((r) => r.metric_date < recentStart));
    const agg = new Map<
      string,
      {
        query: string;
        page: string;
        c: number;
        i: number;
        pw: number;
        w: number;
      }
    >();
    for (const r of recentRows) {
      const k = `${r.query}\u0000${r.page}`;
      const a = agg.get(k) ?? {
        query: r.query,
        page: r.page,
        c: 0,
        i: 0,
        pw: 0,
        w: 0,
      };
      const imp = Number(r.impressions);
      a.c += Number(r.clicks);
      a.i += imp;
      if (r.average_position != null && imp > 0) {
        a.pw += Number(r.average_position) * imp;
        a.w += imp;
      }
      agg.set(k, a);
    }
    const found = [...agg.values()]
      .map((a) => ({
        query: a.query,
        url: a.page,
        currentPosition: a.w > 0 ? Math.round((a.pw / a.w) * 10) / 10 : null,
        impressions: a.i,
        clicks: a.c,
      }))
      .filter(
        (a) =>
          a.clicks === 0 &&
          a.impressions >= 10 &&
          a.currentPosition !== null &&
          a.currentPosition <= 10,
      )
      .sort((x, y) => y.impressions - x.impressions)
      .slice(0, 5);
    ctrCandidates.push(...found);
  }

  // URL coverage: our inventory and Google's inspections, diagnosed per URL.
  const inv = await fetchAllRows<Record<string, unknown>>((from, to) =>
    admin
      .from("url_inventory")
      .select("*")
      .eq("site_id", siteId)
      .order("url")
      .range(from, to),
  );
  const inspRows = await fetchAllRows<Record<string, unknown>>((from, to) =>
    admin
      .from("url_inspections")
      .select(
        "url, ninja_status, coverage_state, last_crawl_time, last_inspected_at, google_canonical, user_canonical",
      )
      .eq("site_id", siteId)
      .order("url")
      .range(from, to),
  );
  const facts = new Map<string, InspectionFact>(
    inspRows.map((i) => [
      i.url as string,
      {
        ninjaStatus: i.ninja_status as string,
        coverageState: (i.coverage_state as string) ?? null,
        lastCrawlTime: (i.last_crawl_time as string) ?? null,
        lastInspectedAt: i.last_inspected_at as string,
        googleCanonical: (i.google_canonical as string) ?? null,
        userCanonical: (i.user_canonical as string) ?? null,
      },
    ]),
  );
  const diagnoses: Diagnosis[] = inv.map((r) =>
    diagnoseUrl(
      {
        url: r.url as string,
        sources: (r.sources as InventoryRow["sources"]) ?? [],
        inSitemap: !!r.in_sitemap,
        isAlias: !!r.is_alias,
        canonicalGroup: (r.canonical_group as string) ?? null,
        liveCheckedAt: (r.live_checked_at as string) ?? null,
        liveStatus: (r.live_status as number) ?? null,
        liveRedirectTo: (r.live_redirect_to as string) ?? null,
        liveCanonical: (r.live_canonical as string) ?? null,
        liveNoindex: (r.live_noindex as boolean) ?? null,
        liveWordCount: (r.live_word_count as number) ?? null,
        liveError: (r.live_error as string) ?? null,
        robotsAllowed: (r.robots_allowed as boolean) ?? null,
      },
      facts.get(r.url as string),
    ),
  );

  // Query intelligence: pages' titles come from our own live checks, Bing
  // corroboration from the stored Bing query data, devices from the weekly
  // Search Analytics snapshot.
  const pageText = new Map<string, string>();
  for (const r of inv) {
    const slug = String(r.url)
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/[-_/]+/g, " ");
    pageText.set(r.url as string, `${(r.live_title as string) ?? ""} ${slug}`);
  }
  const bingImpressions = new Map<string, number>();
  if (through) {
    const bingSince = isoDate(
      new Date(new Date(`${through}T00:00:00Z`).getTime() - 27 * DAY),
    );
    const bingRows = await fetchAllRows<{ query: string; impressions: number }>(
      (from, to) =>
        admin
          .from("search_query_daily")
          .select("query, impressions")
          .eq("site_id", siteId)
          .eq("engine", "bing")
          .gte("metric_date", bingSince)
          .order("metric_date")
          .order("query")
          .range(from, to),
      1000,
      20_000,
    );
    for (const b of bingRows) {
      bingImpressions.set(
        b.query,
        (bingImpressions.get(b.query) ?? 0) + Number(b.impressions),
      );
    }
  }
  let devices: DeviceRow[] = [];
  const { data: devSnap } = await admin
    .from("search_dimension_snapshots")
    .select("captured_at")
    .eq("site_id", siteId)
    .eq("dimension", "device")
    .order("captured_at", { ascending: false })
    .limit(1);
  if (devSnap?.[0]) {
    const { data: dv } = await admin
      .from("search_dimension_snapshots")
      .select("key, clicks, impressions, ctr, position")
      .eq("site_id", siteId)
      .eq("dimension", "device")
      .eq("captured_at", devSnap[0].captured_at)
      .not("key", "like", "%:%");
    devices = (dv ?? []).map((d) => ({
      key: d.key as string,
      clicks: Number(d.clicks),
      impressions: Number(d.impressions),
      ctr: d.ctr != null ? Number(d.ctr) : null,
      position: d.position != null ? Number(d.position) : null,
    }));
  }
  const queryFindings: QueryFinding[] = buildQueryFindings({
    recent: qpRecent,
    previous: qpPrevious,
    pageText,
    bingImpressions,
    devices,
  });

  const assessment = assessSite({
    site,
    mode,
    now,
    audit: auditRun
      ? {
          finishedAt: auditRun.finished_at,
          pagesCrawled: auditRun.pages_crawled,
          healthScore: auditRun.health_score,
          issues,
        }
      : null,
    opportunities: opps ?? [],
    ctrCandidates,
    gscThrough: through,
    diagnoses,
    queryFindings,
    hosting: {
      platform: site.hosting_platform,
      projectId: site.hosting_project_id,
    },
  });

  const { data: run, error: runErr } = await admin
    .from("optimisation_runs")
    .insert({
      site_id: siteId,
      mode,
      finished_at: new Date().toISOString(),
      health: assessment.health,
      summary: {
        counts: assessment.counts,
        top3: assessment.top3.map((i) => i.key),
      },
    })
    .select("id")
    .single();
  if (runErr) throw runErr;

  // Record items as changes. An item already open from an earlier run is
  // refreshed, not duplicated; open items that no longer appear are closed
  // with a note (the history stays).
  const { data: open } = await admin
    .from("optimisation_changes")
    .select("id, evidence, status")
    .eq("site_id", siteId)
    .in("status", ["proposed", "needs_approval"]);
  const openByKey = new Map<string, { id: string; status: string }>();
  for (const o of open ?? []) {
    const k = (o.evidence as { key?: string } | null)?.key;
    if (k) openByKey.set(k, { id: o.id, status: o.status });
  }
  const seen = new Set<string>();
  for (const item of assessment.items) {
    seen.add(item.key);
    const existing = openByKey.get(item.key);
    const fields = {
      run_id: run.id,
      opportunity_id: item.opportunityId ?? null,
      url: item.url,
      title: item.title,
      problem: item.problem,
      recommendation: item.recommendation,
      change_class: item.changeClass,
      risk: item.risk,
      priority: item.priority,
      auto_eligible: item.autoEligible,
      status: item.status,
      deployment: item.deployment,
      deployment_note: item.deploymentNote,
      evidence: { ...item.evidence, key: item.key },
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      await admin
        .from("optimisation_changes")
        .update(fields)
        .eq("id", existing.id);
    } else {
      const { data: created } = await admin
        .from("optimisation_changes")
        .insert({ site_id: siteId, ...fields })
        .select("id")
        .single();
      if (created) {
        await admin.from("optimisation_events").insert({
          site_id: siteId,
          change_id: created.id,
          actor: "system",
          event: "proposed",
          detail: item.title,
        });
      }
    }
  }
  for (const [k, v] of openByKey) {
    if (seen.has(k)) continue;
    await admin
      .from("optimisation_changes")
      .update({
        status: "rejected",
        note: "No longer found in the latest analysis.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", v.id);
    await admin.from("optimisation_events").insert({
      site_id: siteId,
      change_id: v.id,
      actor: "system",
      event: "closed",
      detail: "No longer found in the latest analysis.",
    });
  }

  await admin.from("site_optimisation").upsert({
    site_id: siteId,
    last_run_id: run.id,
    last_run_at: new Date().toISOString(),
  });

  return {
    runId: run.id,
    reused: false,
    mode,
    health: assessment.health,
    counts: assessment.counts,
  };
});
