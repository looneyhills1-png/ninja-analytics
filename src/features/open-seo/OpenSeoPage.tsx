import { useMemo, useState } from "react";
import { useSites } from "@/lib/hooks";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePrivacyMode } from "@/lib/privacy";

type Project = { id: string; name: string; domain?: string | null; locationCode?: number; languageCode?: string };
type Keyword = { id: string; keyword: string; searchVolume?: number | null; keywordDifficulty?: number | null; cpc?: number | null; tags?: string[] };
type RankTracker = { id: string; domain: string; scheduleInterval?: string; lastCheckedAt?: string | null; lastSkipReason?: string | null };
type Tracker = {
  configured: boolean;
  tracker: { enabled: boolean; scheduleInterval: string; lastSkipReason?: string | null } | null;
  prompts: Array<{ id: string; text: string; paused: boolean; archived: boolean; hasResults: boolean }>;
  engines: string[];
  recentRuns: Array<{ id: string; status: string; createdAt: string; trigger: string }>;
};
type Visibility = {
  runId: string | null;
  rows: Array<{ id: string; prompt: string; engine: string; status: string; brands: Array<{ own: boolean; mentioned: boolean; cited: boolean; name: string }> }>;
  summaries: Array<{ name: string; own: boolean; answers: number; mentions: number; citations: number }>;
  coverage: { expected: number; completed: number; failed: number; noAnswer: number };
};
type Sources = { rows: Array<{ key: string; domain: string; ownership: string; answerCount: number; promptCount: number }>; totalCount: number };
type Trend = { comparison: string; citations: { current: number | null; previous: number | null }; mentions: { current: number | null; previous: number | null } };
type Snapshot = { keyword?: { rows: Keyword[]; totalCount: number }; rank?: { configs: RankTracker[] }; tracker?: Tracker; visibility?: Visibility; sources?: Sources; trend?: Trend };
type ToolResponse<T> = { ok: boolean; data?: T; error?: string; cached?: boolean };

function hostname(input: string | null | undefined) {
  if (!input) return "";
  try { return new URL(input.includes("://") ? input : "https://" + input).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return input.toLowerCase().replace(/^www\./, "").split("/")[0]; }
}

async function readTool<T>(tool: string, args: Record<string, string> = {}): Promise<T> {
  const response = await fetch("/open-seo/read", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ninja-local": "1" },
    body: JSON.stringify({ tool, args }),
  });
  const payload = (await response.json()) as ToolResponse<T>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(payload.error || "OpenSEO did not return usable evidence");
  }
  return payload.data;
}
function fmt(value: number | null | undefined) { return value == null ? "—" : value.toLocaleString(); }
function pct(value: number | null | undefined) { return value == null ? "—" : value.toFixed(1) + "%"; }
function readable(text: string, privacy: { enabled: boolean; maskText: (s: string, k?: string) => string }, key: string) {
  return privacy.enabled ? privacy.maskText(text, key) : text;
}

export function OpenSeoPage() {
  const sitesQuery = useSites();
  const privacy = usePrivacyMode();
  const sites = (sitesQuery.data ?? []).filter((site) => site.is_active);
  const [siteId, setSiteId] = useState("");
  const selected = sites.find((s) => s.id === siteId) ?? sites[0];
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState("");
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadedProject, setLoadedProject] = useState<Project | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({});
  const [warnings, setWarnings] = useState<string[]>([]);

  const matchedProject = useMemo(() => {
    if (!selected) return undefined;
    return projects.find((p) => hostname(p.domain) === hostname(selected.domain));
  }, [projects, selected]);

  async function load() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setWarnings([]);
    setSnapshot({});
    setLoadedProject(null);
    try {
      const statusResponse = await fetch("/open-seo/status", { headers: { "x-ninja-local": "1" } });
      const status = (await statusResponse.json()) as { online: boolean; message: string };
      setHealth(status.message);
      if (!status.online) throw new Error("OpenSEO is not running on the Recoil (127.0.0.1:3001). No paid lookups were attempted.");
      const projectResult = await readTool<{ projects: Project[] }>("list_projects");
      setProjects(projectResult.projects);
      const project = projectResult.projects.find((p) => hostname(p.domain) === hostname(selected.domain));
      if (!project) {
        throw new Error("OpenSEO is connected, but this website has no matching OpenSEO project. Add the domain in the local OpenSEO app first.");
      }
      // Only read previously stored evidence. No live SERP, keyword, backlink,
      // AI-answer or crawl jobs are started, and no paid tools are callable.
      const names = ["list_saved_keywords", "get_rank_tracker", "get_ai_visibility_tracker", "get_ai_visibility_results", "get_ai_visibility_sources", "get_ai_visibility_trend"] as const;
      const results = await Promise.allSettled(names.map((tool) => readTool<unknown>(tool, { projectId: project.id })));
      const next: Snapshot = {};
      const failures: string[] = [];
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          failures.push(names[i] + ": " + (r.reason instanceof Error ? r.reason.message : "unavailable"));
          return;
        }
        const data = r.value;
        if (i === 0) next.keyword = data as Snapshot["keyword"];
        if (i === 1) next.rank = data as Snapshot["rank"];
        if (i === 2) next.tracker = data as Snapshot["tracker"];
        if (i === 3) next.visibility = data as Snapshot["visibility"];
        if (i === 4) next.sources = data as Snapshot["sources"];
        if (i === 5) next.trend = data as Snapshot["trend"];
      });
      setWarnings(failures);
      setSnapshot(next);
      setLoadedProject(project);
    } catch (e) {
      setError(e instanceof Error ? e.message : "OpenSEO connection failed");
    } finally {
      setBusy(false);
    }
  }

  if (sitesQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading websites…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">OpenSEO Intelligence</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Existing OpenSEO keyword, rank and AI-answer evidence alongside Ninja Analytics.
            Read-only, on demand, with paid API lookups and background collection disabled.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-9 rounded-md border border-border bg-card px-2 text-sm"
            value={selected?.id ?? ""}
            onChange={(e) => { setSiteId(e.target.value); setLoadedProject(null); setSnapshot({}); setError(""); }}
            aria-label="Website"
          >
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Button onClick={() => void load()} disabled={!selected || busy}>
            {busy ? "Reading existing evidence…" : "Connect & load free evidence"}
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <p className="text-sm font-medium">Connection and spending protection</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Local MCP: 127.0.0.1:3001 · zero paid requests · no background polling · max 60 read requests/hour · 60-second cache.
          No API key is stored in the browser or this repository. OpenSEO project mapping is by exact website hostname.
        </p>
        {health && <p className="mt-2 text-xs">{health}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-warning">{error}</p>}
        {matchedProject && <p className="mt-2 text-xs">Project available: {readable(matchedProject.name, privacy, matchedProject.id)}</p>}
        {loadedProject && <p className="mt-2 text-xs text-success">Read completed for {readable(loadedProject.domain ?? loadedProject.name, privacy, loadedProject.id)}. Values below are cached OpenSEO evidence, not new measurements.</p>}
        <a href="http://127.0.0.1:3001" target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-primary underline">
          Open local OpenSEO dashboard
        </a>
      </Card>

      {warnings.length > 0 && (
        <Card className="p-4">
          <p className="text-sm font-medium">Some evidence could not be loaded</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Card>
      )}

      {loadedProject && (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            {[
              ["Saved keywords", snapshot.keyword?.totalCount],
              ["Rank trackers", snapshot.rank?.configs.length],
              ["Active AI prompts", snapshot.tracker?.prompts.filter((p) => !p.paused && !p.archived).length],
              ["Completed AI answers", snapshot.visibility?.coverage.completed],
            ].map(([label, count]) => (
              <Card key={String(label)} className="p-4">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold">{typeof count === "number" ? fmt(count) : "Unavailable"}</p>
              </Card>
            ))}
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-border p-4">
              <h2 className="font-semibold">Saved keyword research</h2>
              <p className="text-xs text-muted-foreground">Existing OpenSEO metrics only. Search volume and difficulty remain unavailable when no provider data was saved.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-xs"><tr><th className="p-3">Keyword</th><th className="p-3">Volume</th><th className="p-3">Difficulty</th><th className="p-3">CPC ($)</th></tr></thead>
                <tbody>
                  {(snapshot.keyword?.rows ?? []).slice(0, 30).map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="p-3">{readable(r.keyword, privacy, r.id)}</td>
                      <td className="p-3">{fmt(r.searchVolume)}</td>
                      <td className="p-3">{fmt(r.keywordDifficulty)}</td>
                      <td className="p-3">{r.cpc == null ? "—" : r.cpc.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!snapshot.keyword?.rows?.length && <p className="p-4 text-xs text-muted-foreground">No saved keyword evidence available.</p>}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h2 className="font-semibold">Rank tracking</h2>
              <p className="mb-3 text-xs text-muted-foreground">Recorded checks, not GSC average position. This page never runs rank checks.</p>
              {(snapshot.rank?.configs ?? []).map((r) => (
                <div key={r.id} className="border-t border-border py-3 text-sm">
                  <p className="font-medium">{readable(r.domain, privacy, r.id)}</p>
                  <p className="text-xs text-muted-foreground">Last checked: {r.lastCheckedAt ?? "Never"} · Schedule: {r.scheduleInterval ?? "Unknown"}</p>
                  {r.lastSkipReason && <p className="text-xs text-warning">{r.lastSkipReason}</p>}
                </div>
              ))}
              {!snapshot.rank?.configs?.length && <p className="text-xs text-muted-foreground">No existing rank trackers.</p>}
            </Card>
            <Card className="p-4">
              <h2 className="font-semibold">AI answer visibility</h2>
              <p className="text-xs text-muted-foreground">
                Tracked answers from OpenSEO's prior runs only. Missing results do not mean your domain was never mentioned.
              </p>
              <p className="mt-3 text-sm">Prompts: {snapshot.tracker?.prompts.length ?? "—"} · Engines: {snapshot.tracker?.engines.length ?? "—"}</p>
              <p className="text-xs text-muted-foreground">Latest check: {snapshot.tracker?.recentRuns[0]?.createdAt ?? "Not collected"}</p>
              <p className="mt-2 text-sm">Mentions: {pct(snapshot.trend?.mentions.current)} · Citations: {pct(snapshot.trend?.citations.current)}</p>
              <p className="text-xs text-muted-foreground">28-day comparison: {snapshot.trend?.comparison ?? "Unavailable"}</p>
              {snapshot.tracker?.tracker?.enabled && (
                <p className="mt-2 text-xs text-warning">Warning: OpenSEO's own tracker is enabled and may spend credits independently. Disable its schedule inside OpenSEO.</p>
              )}
            </Card>
          </div>

          <Card className="p-4">
            <h2 className="font-semibold">AI brand comparisons</h2>
            <p className="mb-2 text-xs text-muted-foreground">Evidence from the latest saved baseline/scheduled run; counts are observations, not market-wide share.</p>
            {(snapshot.visibility?.summaries ?? []).map((s) => (
              <div key={s.name} className="grid grid-cols-4 gap-2 border-b border-border py-2 text-xs">
                <span className="font-medium">{readable(s.name, privacy, s.name)}{s.own ? " (you)" : ""}</span>
                <span>Answers {fmt(s.answers)}</span><span>Mentions {fmt(s.mentions)}</span><span>Citations {fmt(s.citations)}</span>
              </div>
            ))}
            {!snapshot.visibility?.summaries?.length && <p className="text-xs text-muted-foreground">No completed AI brand comparison yet.</p>}
          </Card>

          <Card className="p-4">
            <h2 className="font-semibold">AI-cited sources</h2>
            <p className="mb-2 text-xs text-muted-foreground">Actual URLs/domains captured by OpenSEO, never inferred backlinks.</p>
            {(snapshot.sources?.rows ?? []).slice(0, 15).map((r) => (
              <div key={r.key} className="grid gap-2 border-b border-border py-2 text-xs sm:grid-cols-3">
                <span className="break-all">{readable(r.domain, privacy, r.key)}</span>
                <span>{r.ownership}</span>
                <span>{fmt(r.answerCount)} answers · {fmt(r.promptCount)} prompts</span>
              </div>
            ))}
            {!snapshot.sources?.rows?.length && <p className="text-xs text-muted-foreground">No saved source observations.</p>}
          </Card>
          <p className="text-xs text-muted-foreground">
            Paid keyword expansion, competitor keyword databases, backlink indexes, fresh AI prompts and new site crawls remain intentionally disabled.
            Those features cannot be truthfully populated without a provider or explicit paid-data authorisation.
          </p>
        </>
      )}
    </div>
  );
}
