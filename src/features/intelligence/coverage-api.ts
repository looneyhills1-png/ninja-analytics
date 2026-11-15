import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import {
  diagnoseUrl,
  type Diagnosis,
  type InspectionFact,
  type InventoryRow,
} from "../../../supabase/functions/_shared/coverage";
import type { Database } from "@/types/database";

type Json = Database["public"]["Tables"]["optimisation_runs"]["Row"]["health"];

export interface CoverageSnapshot {
  id: string;
  site_id: string;
  captured_at: string;
  discovered: number;
  live_checked: number;
  inspected: number;
  indexed: number;
  excluded: number;
  unknown_state: number;
  technical_errors: number;
  complete: boolean;
  detail: Json;
}

export interface CoverageDetail {
  indexedTotal?: number | null;
  excludedTotal?: number | null;
  excludedByReason?: Array<{ reason: string; count: number; urls: string[] }>;
  technicalErrors?: Array<{ url: string; problem: string }>;
}

export interface SitemapStatus {
  path: string;
  last_submitted: string | null;
  last_downloaded: string | null;
  is_pending: boolean | null;
  warnings: number | null;
  errors: number | null;
  contents: unknown;
}

const key = (siteId: string) => ["coverage", siteId] as const;

// The generated Database type does not list the 0028 tables yet; these thin
// untyped reads keep the types honest at the boundary above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (name: string) => (supabase as any).from(name);

export async function getLatestSnapshots(
  siteId?: string,
): Promise<CoverageSnapshot[]> {
  let q = table("coverage_snapshots")
    .select("*")
    .order("captured_at", { ascending: false })
    .limit(siteId ? 2 : 60);
  if (siteId) q = q.eq("site_id", siteId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CoverageSnapshot[];
}

export const useCoverageSnapshots = (siteId: string) =>
  useQuery({
    queryKey: key(siteId),
    queryFn: async () => {
      const [snaps, maps] = await Promise.all([
        getLatestSnapshots(siteId),
        table("gsc_sitemaps").select("*").eq("site_id", siteId).limit(20),
      ]);
      if (maps.error) throw maps.error;
      return {
        latest: snaps[0] ?? null,
        previous: snaps[1] ?? null,
        sitemaps: (maps.data ?? []) as SitemapStatus[],
      };
    },
    enabled: !!siteId,
  });

/** Latest snapshot per site, for the Overview. */
export const useAllCoverage = () =>
  useQuery({
    queryKey: ["coverage", "all"] as const,
    queryFn: async () => {
      const snaps = await getLatestSnapshots();
      const latest = new Map<string, CoverageSnapshot>();
      for (const s of snaps)
        if (!latest.has(s.site_id)) latest.set(s.site_id, s);
      return latest;
    },
  });

export interface UrlDetail {
  diagnosis: Diagnosis;
  inspectionLink: string | null;
  lastInspectedAt: string | null;
}

/** Per-URL detail. Only fetched when the owner opens the list. */
export async function getUrlDetails(siteId: string): Promise<UrlDetail[]> {
  const [inv, insp] = await Promise.all([
    table("url_inventory")
      .select("*")
      .eq("site_id", siteId)
      .order("url")
      .limit(1000),
    table("url_inspections")
      .select(
        "url, ninja_status, coverage_state, last_crawl_time, last_inspected_at, inspection_result_link",
      )
      .eq("site_id", siteId)
      .limit(1000),
  ]);
  if (inv.error) throw inv.error;
  if (insp.error) throw insp.error;
  const facts = new Map<string, InspectionFact & { link: string | null }>();
  for (const i of insp.data ?? []) {
    facts.set(i.url, {
      ninjaStatus: i.ninja_status,
      coverageState: i.coverage_state,
      lastCrawlTime: i.last_crawl_time,
      lastInspectedAt: i.last_inspected_at,
      link: i.inspection_result_link,
    });
  }
  return (inv.data ?? []).map((r: Record<string, unknown>) => {
    const row: InventoryRow = {
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
    };
    const f = facts.get(row.url);
    return {
      diagnosis: diagnoseUrl(row, f),
      inspectionLink: f?.link ?? null,
      lastInspectedAt: f?.lastInspectedAt ?? null,
    };
  });
}

export const useUrlDetails = (siteId: string, enabled: boolean) =>
  useQuery({
    queryKey: ["coverage-urls", siteId] as const,
    queryFn: () => getUrlDetails(siteId),
    enabled,
  });

export function useCheckCoverage(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<{
        ok?: boolean;
        sites?: Array<Record<string, unknown>>;
      }>("coverage-sync", { body: { siteId } });
      if (error) {
        throw new Error("The coverage check could not be completed.");
      }
      return data;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key(siteId) });
      void qc.invalidateQueries({ queryKey: ["coverage-urls", siteId] });
      void qc.invalidateQueries({ queryKey: ["coverage", "all"] });
      void qc.invalidateQueries({ queryKey: ["optimise", siteId] });
    },
  });
}
