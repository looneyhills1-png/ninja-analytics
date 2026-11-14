// neuron-sync: read-only import of existing NEURONwriter analyses.
// Uses only the documented list-projects / list-queries / get-query endpoints.
// Never calls new-query (analysis credits) and never touches AI Visibility
// (no documented API). Disabled, not failing, until NEURONWRITER_API_KEY is set.

import { fetchWithRetry } from "../_shared/http.ts";
import {
  matchSiteByProjectName,
  NEURON_BASE,
  normalizeAnalysis,
  normalizeProjects,
  normalizeQueryList,
} from "../_shared/neuronwriter.ts";
import {
  checkGuard,
  loadGuard,
  recordCall,
  recordFailure,
  recordSuccess,
  saveGuard,
  serveIntel,
} from "../_shared/intel-common.ts";

const PROVIDER = "neuronwriter";
const GUARD = { maxFailures: 3, openMs: 6 * 3_600_000, dailyQuota: 80 };
const MAX_QUERIES_PER_PROJECT = 25;
const MAX_GET_QUERY_PER_RUN = 40;

class AuthFailure extends Error {}

serveIntel(async ({ admin, trigger }) => {
  const key = Deno.env.get("NEURONWRITER_API_KEY");
  if (!key) {
    return { enabled: false, reason: "api_key_not_configured", trigger };
  }
  const now = new Date();
  let guard = await loadGuard(admin, PROVIDER, now);
  const gate = checkGuard(guard, now, GUARD);
  if (!gate.allowed) return { enabled: true, skipped: gate.reason, trigger };

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const g = checkGuard(guard, new Date(), GUARD);
    if (!g.allowed) throw new Error(g.reason);
    guard = recordCall(guard, new Date());
    const res = await fetchWithRetry(
      `${NEURON_BASE}/${path}`,
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: 20_000, maxRetries: 2 },
    );
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new AuthFailure(`HTTP ${res.status}`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  };

  let projectsSeen = 0;
  let analysesWritten = 0;
  let cached = 0;
  let getQueryCalls = 0;
  try {
    const projects = normalizeProjects(await post("list-projects", {}));
    const { data: sites } = await admin
      .from("sites")
      .select("id, domain")
      .eq("is_active", true);

    for (const p of projects) {
      projectsSeen += 1;
      const siteId = matchSiteByProjectName(p.name, sites ?? []);
      await admin.from("neuron_projects").upsert({
        neuron_project_id: p.neuronProjectId,
        name: p.name,
        engine: p.engine,
        language: p.language,
        site_id: siteId,
        fetched_at: now.toISOString(),
      });

      const list = normalizeQueryList(
        await post("list-queries", {
          project: p.neuronProjectId,
          status: "ready",
        }),
      )
        .sort((a, b) => (b.updatedSrc ?? "").localeCompare(a.updatedSrc ?? ""))
        .slice(0, MAX_QUERIES_PER_PROJECT);

      const { data: existing } = await admin
        .from("neuron_analyses")
        .select("neuron_query_id, updated_src")
        .eq("neuron_project_id", p.neuronProjectId);
      const known = new Map(
        (existing ?? []).map((r) => [
          r.neuron_query_id as string,
          r.updated_src as string | null,
        ]),
      );

      for (const item of list) {
        const prev = known.get(item.neuronQueryId);
        if (
          prev &&
          item.updatedSrc &&
          new Date(prev).getTime() === new Date(item.updatedSrc).getTime()
        ) {
          cached += 1; // unchanged since last fetch: don't spend a call
          continue;
        }
        if (getQueryCalls >= MAX_GET_QUERY_PER_RUN) break;
        getQueryCalls += 1;
        const analysis = normalizeAnalysis(
          item,
          await post("get-query", { query: item.neuronQueryId }),
        );
        const { error } = await admin.from("neuron_analyses").upsert({
          neuron_query_id: analysis.neuronQueryId,
          neuron_project_id: p.neuronProjectId,
          site_id: siteId,
          keyword: analysis.keyword,
          status: analysis.status,
          source: analysis.source,
          created_src: analysis.createdSrc,
          updated_src: analysis.updatedSrc,
          terms: analysis.terms,
          questions: analysis.questions,
          competitors: analysis.competitors,
          fetched_at: new Date().toISOString(),
        });
        if (error) throw error;
        analysesWritten += 1;
      }
    }
    guard = recordSuccess(guard);
    await saveGuard(admin, PROVIDER, guard, now, { ok: true });
    return {
      enabled: true,
      trigger,
      projectsSeen,
      analysesWritten,
      cached,
      getQueryCalls,
    };
  } catch (err) {
    guard = recordFailure(guard, new Date(), GUARD);
    const code = err instanceof AuthFailure ? "auth_error" : "provider_error";
    await saveGuard(admin, PROVIDER, guard, now, {
      ok: false,
      code,
      message: err instanceof Error ? err.message.slice(0, 200) : "error",
    });
    return {
      enabled: true,
      trigger,
      failed: code,
      projectsSeen,
      analysesWritten,
    };
  }
});
