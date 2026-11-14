import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { supabase } from "@/lib/supabase";
import type {
  AiReadinessFinding,
  AiReadinessRun,
  CollectorState,
  NeuronAnalysis,
  NeuronProject,
  OpportunityRow,
} from "@/types/database";

const keys = {
  opportunities: ["intel", "opportunities"] as const,
  readiness: (siteId: string) => ["intel", "readiness", siteId] as const,
  neuronProjects: ["intel", "neuron-projects"] as const,
  neuronAnalyses: (siteId: string) =>
    ["intel", "neuron-analyses", siteId] as const,
  aiReferrals: (siteId: string, days: number) =>
    ["intel", "ai-referrals", siteId, days] as const,
  collectors: ["intel", "collectors"] as const,
};

export async function getOpportunities(): Promise<OpportunityRow[]> {
  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .eq("status", "open")
    .order("priority", { ascending: false })
    .limit(500);
  if (error) throw error;
  return data ?? [];
}

export interface ReadinessResult {
  run: AiReadinessRun | null;
  findings: AiReadinessFinding[];
}

export async function getLatestReadiness(
  siteId: string,
): Promise<ReadinessResult> {
  const { data: runs, error } = await supabase
    .from("ai_readiness_runs")
    .select("*")
    .eq("site_id", siteId)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const run = runs?.[0] ?? null;
  if (!run) return { run: null, findings: [] };
  const { data: findings, error: fErr } = await supabase
    .from("ai_readiness_findings")
    .select("*")
    .eq("run_id", run.id)
    .order("checked_at")
    .limit(2000);
  if (fErr) throw fErr;
  return { run, findings: findings ?? [] };
}

export async function getNeuronProjects(): Promise<NeuronProject[]> {
  const { data, error } = await supabase
    .from("neuron_projects")
    .select("*")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function getNeuronAnalyses(
  siteId: string,
): Promise<NeuronAnalysis[]> {
  const { data, error } = await supabase
    .from("neuron_analyses")
    .select("*")
    .eq("site_id", siteId)
    .order("updated_src", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

export interface AiReferralTotal {
  provider: string;
  sessions: number;
  users: number;
  pageViews: number;
}

export async function getAiReferrals(
  siteId: string,
  days: number,
): Promise<{ totals: AiReferralTotal[]; latestDate: string | null }> {
  const since = format(subDays(new Date(), days), "yyyy-MM-dd");
  const { data, error } = await supabase
    .from("ga4_breakdown_daily")
    .select(
      "metric_date, dimension_value, sessions, active_users, screen_page_views",
    )
    .eq("site_id", siteId)
    .eq("dimension", "ai_referrer")
    .gte("metric_date", since)
    .limit(5000);
  if (error) throw error;
  const map = new Map<string, AiReferralTotal>();
  let latestDate: string | null = null;
  for (const r of data ?? []) {
    const t = map.get(r.dimension_value) ?? {
      provider: r.dimension_value,
      sessions: 0,
      users: 0,
      pageViews: 0,
    };
    t.sessions += r.sessions ?? 0;
    t.users += r.active_users ?? 0;
    t.pageViews += r.screen_page_views ?? 0;
    map.set(r.dimension_value, t);
    if (!latestDate || r.metric_date > latestDate) latestDate = r.metric_date;
  }
  return {
    totals: [...map.values()].sort((a, b) => b.sessions - a.sessions),
    latestDate,
  };
}

export async function getCollectorStates(): Promise<CollectorState[]> {
  const { data, error } = await supabase.from("collector_state").select("*");
  if (error) throw error;
  return data ?? [];
}

export type IntelFunction =
  | "ai-readiness-audit"
  | "neuron-sync"
  | "build-opportunities"
  | "ai-referrals-sync";

export async function invokeIntel(
  name: IntelFunction,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke<
    Record<string, unknown>
  >(name, { body });
  if (error)
    throw new Error("The request failed. Check Sync history and try again.");
  return data ?? {};
}

// Hooks ------------------------------------------------------------------------

export const useOpportunities = () =>
  useQuery({ queryKey: keys.opportunities, queryFn: getOpportunities });

export const useLatestReadiness = (siteId: string) =>
  useQuery({
    queryKey: keys.readiness(siteId),
    queryFn: () => getLatestReadiness(siteId),
    enabled: !!siteId,
  });

export const useNeuronProjects = () =>
  useQuery({ queryKey: keys.neuronProjects, queryFn: getNeuronProjects });

export const useNeuronAnalyses = (siteId: string) =>
  useQuery({
    queryKey: keys.neuronAnalyses(siteId),
    queryFn: () => getNeuronAnalyses(siteId),
    enabled: !!siteId,
  });

export const useAiReferrals = (siteId: string, days: number) =>
  useQuery({
    queryKey: keys.aiReferrals(siteId, days),
    queryFn: () => getAiReferrals(siteId, days),
    enabled: !!siteId,
  });

export const useCollectorStates = () =>
  useQuery({ queryKey: keys.collectors, queryFn: getCollectorStates });

export function useRunIntel(name: IntelFunction) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown> = {}) => invokeIntel(name, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["intel"] });
    },
  });
}

export function useSetOpportunityStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; status: "dismissed" | "done" }) => {
      const { error } = await supabase
        .from("opportunities")
        .update({ status: v.status })
        .eq("id", v.id);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.opportunities });
    },
  });
}
