import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { judgeOutcome } from "../../../supabase/functions/_shared/outcome";
import type {
  OptimisationChange,
  OptimisationRun,
  SiteOptimisation,
} from "@/types/database";

export type OptimiseMode = SiteOptimisation["mode"];

const key = (siteId: string) => ["optimise", siteId] as const;

export interface OptimiseState {
  mode: OptimiseMode;
  run: OptimisationRun | null;
  changes: OptimisationChange[];
}

export async function getOptimiseState(siteId: string): Promise<OptimiseState> {
  const [setting, run, changes] = await Promise.all([
    supabase
      .from("site_optimisation")
      .select("*")
      .eq("site_id", siteId)
      .maybeSingle(),
    supabase
      .from("optimisation_runs")
      .select("*")
      .eq("site_id", siteId)
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("optimisation_changes")
      .select("*")
      .eq("site_id", siteId)
      .order("priority", { ascending: false })
      .limit(100),
  ]);
  if (setting.error) throw setting.error;
  if (run.error) throw run.error;
  if (changes.error) throw changes.error;
  return {
    mode: setting.data?.mode ?? "monitor",
    run: run.data?.[0] ?? null,
    changes: changes.data ?? [],
  };
}

export const useOptimiseState = (siteId: string) =>
  useQuery({
    queryKey: key(siteId),
    queryFn: () => getOptimiseState(siteId),
    enabled: !!siteId,
  });

async function invoke<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) {
    throw new Error("The request failed. Check Sync history and try again.");
  }
  return (data ?? {}) as T;
}

export interface AnalyseProgress {
  step: string;
}

interface AnalyseResult {
  ok?: boolean;
  runId?: string;
  reused?: boolean;
  error?: string;
}
interface ApplyResult {
  ok?: boolean;
  error?: string;
  reasons?: string[];
  message?: string;
}

/** Analyse & Optimise: a bounded, ordered sequence. The crawl is read-only
 * (the existing site audit, at most 100 pages) and only runs when the last
 * audit is stale. In safe_auto mode at most MAX_AUTO changes are then handed
 * to the guarded optimise-apply function, which re-checks everything itself. */
export const MAX_AUTO = 2;
const AUDIT_REFRESH_DAYS = 7;

export function useAnalyse(siteId: string, onProgress: (step: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (state: OptimiseState) => {
      const health = state.run?.health as
        | { auditAgeDays?: number | null }
        | undefined;
      const auditAge = health?.auditAgeDays;
      if (auditAge == null || auditAge > AUDIT_REFRESH_DAYS) {
        onProgress("Checking your site (read-only, up to 100 pages)…");
        try {
          await invoke("site-audit-crawl", { siteId });
        } catch {
          // A failed crawl must not block the assessment of existing data.
        }
      }
      onProgress("Analysing your data…");
      const res = await invoke<AnalyseResult>("analyse-site", { siteId });
      if (res.ok === false) {
        throw new Error(
          res.error === "rate_limited"
            ? "The daily analysis limit for this site has been reached."
            : "The analysis could not be completed.",
        );
      }
      const applied: string[] = [];
      const refused: string[] = [];
      if (state.mode === "safe_auto" && !res.reused) {
        const { data: proposed } = await supabase
          .from("optimisation_changes")
          .select("id, title")
          .eq("site_id", siteId)
          .eq("status", "proposed")
          .eq("auto_eligible", true)
          .order("priority", { ascending: false })
          .limit(MAX_AUTO);
        for (const c of proposed ?? []) {
          onProgress(`Applying: ${c.title}`);
          const r = await invoke<ApplyResult>("optimise-apply", {
            changeId: c.id,
            action: "apply",
          });
          if (r.ok) applied.push(c.title);
          else
            refused.push(
              `${c.title}: ${(r.reasons ?? [r.message ?? "refused"]).join(" ")}`,
            );
        }
      }
      return { reused: Boolean(res.reused), applied, refused };
    },
    onSettled: () => {
      onProgress("");
      void qc.invalidateQueries({ queryKey: key(siteId) });
    },
  });
}

export function useSetMode(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mode: OptimiseMode) => {
      const { error } = await supabase
        .from("site_optimisation")
        .update({ mode })
        .eq("site_id", siteId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(siteId) }),
  });
}

export function useChangeAction(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: {
      changeId: string;
      action: "rollback" | "dismiss";
    }) => {
      const r = await invoke<ApplyResult>("optimise-apply", a);
      if (r.ok === false) {
        throw new Error(
          r.message ?? (r.reasons ?? []).join(" ") ?? "The action was refused.",
        );
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(siteId) }),
  });
}

export interface ChangeOutcome {
  verdict:
    | "improved"
    | "declined"
    | "no_clear_change"
    | "too_early"
    | "no_data";
  text: string;
  before?: { clicks: number; impressions: number; position: number | null };
  after?: { clicks: number; impressions: number; position: number | null };
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Search Console numbers for the changed page: 28 days before the change vs.
 * the days since. Judged only after at least 14 days (see outcome.ts). */
export async function measureChange(
  c: OptimisationChange,
): Promise<ChangeOutcome> {
  if (!c.url) return { verdict: "no_data", text: "No single page to measure." };
  const changedAt = new Date(c.updated_at).getTime();
  const { data, error } = await supabase
    .from("search_page_daily")
    .select("metric_date, clicks, impressions, average_position")
    .eq("page", c.url)
    .eq("site_id", c.site_id)
    .eq("engine", "google")
    .gte("metric_date", iso(changedAt - 28 * DAY))
    .order("metric_date")
    .limit(500);
  if (error) throw error;
  const sum = (rows: typeof data) => {
    let clicks = 0;
    let impressions = 0;
    let pw = 0;
    let w = 0;
    for (const r of rows ?? []) {
      const i = Number(r.impressions);
      clicks += Number(r.clicks);
      impressions += i;
      if (r.average_position != null && i > 0) {
        pw += Number(r.average_position) * i;
        w += i;
      }
    }
    return {
      clicks,
      impressions,
      position: w > 0 ? Math.round((pw / w) * 10) / 10 : null,
    };
  };
  const cut = iso(changedAt);
  const before = sum((data ?? []).filter((r) => r.metric_date < cut));
  const afterRows = (data ?? []).filter((r) => r.metric_date >= cut);
  const after = sum(afterRows);
  const days = afterRows.length
    ? Math.floor(
        (new Date(
          `${afterRows[afterRows.length - 1].metric_date}T00:00:00Z`,
        ).getTime() -
          changedAt) /
          DAY,
      )
    : 0;
  const j = judgeOutcome(before, after, Math.max(0, days));
  return { verdict: j.verdict, text: j.reason, before, after };
}

export const useChangeOutcome = (c: OptimisationChange, enabled: boolean) =>
  useQuery({
    queryKey: ["optimise-outcome", c.id, c.updated_at],
    queryFn: () => measureChange(c),
    enabled,
  });
