import { useMemo, useState } from "react";
import { DownloadCloud, Info } from "lucide-react";
import { useSites } from "@/lib/hooks";
import { relativeTime } from "@/lib/dates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useNeuronAnalyses, useNeuronProjects, useRunIntel } from "./intel-api";
import { ProvenanceBadge, SitePicker } from "./Provenance";

interface Competitor {
  url: string | null;
  title: string | null;
  contentScore: number | null;
}

export function ContentIntelligencePage() {
  const sitesQuery = useSites();
  const sites = useMemo(
    () => (sitesQuery.data ?? []).filter((s) => s.is_active),
    [sitesQuery.data],
  );
  const [picked, setPicked] = useState("");
  const siteId =
    picked && sites.some((s) => s.id === picked)
      ? picked
      : (sites[0]?.id ?? "");
  const projects = useNeuronProjects();
  const analyses = useNeuronAnalyses(siteId);
  const sync = useRunIntel("neuron-sync");

  const project = (projects.data ?? []).find((p) => p.site_id === siteId);
  const syncReason = sync.data?.reason as string | undefined;
  const notConfigured = syncReason === "api_key_not_configured";
  const failed = sync.data?.failed as string | undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Content Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            Existing NEURONwriter analyses, fetched read-only. Ninja Analytics
            never creates analyses or uses analysis credits.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SitePicker sites={sites} value={siteId} onChange={setPicked} />
          <Button
            variant="secondary"
            size="sm"
            disabled={sync.isPending}
            onClick={() => sync.mutate({})}
          >
            <DownloadCloud className="h-4 w-4" aria-hidden />
            {sync.isPending ? "Fetching…" : "Fetch existing analyses"}
          </Button>
        </div>
      </div>

      {notConfigured && (
        <Card className="flex gap-3 border-warning/30 bg-warning/10 p-4 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p>
            NEURONwriter is not connected on this PC: no API key is configured,
            so nothing has been fetched. Add <code>NEURONWRITER_API_KEY</code>{" "}
            to the Supabase stack settings (API access needs the Gold plan or
            higher), then fetch again.
          </p>
        </Card>
      )}
      {failed && (
        <p role="alert" className="text-sm text-critical">
          NEURONwriter fetch failed ({failed}). It will retry on the next daily
          run.
        </p>
      )}

      <Card className="flex gap-3 p-4 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          NEURONwriter does not document an API for its AI Visibility feature,
          so no AI Visibility data is imported here. Content scores for your own
          pages are likewise not provided by the read endpoints and are not
          shown.
        </p>
      </Card>

      {projects.isLoading || analyses.isLoading ? (
        <Skeleton className="h-64" />
      ) : !project ? (
        <EmptyState
          title="No NEURONwriter project linked to this site"
          description="Projects are matched to sites by domain once the API key is configured and a fetch has run."
        />
      ) : (analyses.data ?? []).length === 0 ? (
        <EmptyState
          title="No analyses fetched yet"
          description={`Project “${project.name}” is linked (${project.engine ?? "?"} · ${project.language ?? "?"}), but no ready analyses have been fetched.`}
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Project {project.name} · {project.engine ?? "?"} ·{" "}
            {project.language ?? "?"} · last fetched{" "}
            {relativeTime(project.fetched_at)}
          </p>
          <ul className="space-y-3">
            {(analyses.data ?? []).map((a) => {
              const questions = (a.questions as string[]) ?? [];
              const competitors =
                (a.competitors as unknown as Competitor[]) ?? [];
              return (
                <li key={a.neuron_query_id}>
                  <Card className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold">{a.keyword}</h2>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <ProvenanceBadge kind="verified" />
                        <span>
                          {a.status} · analysis updated{" "}
                          {a.updated_src
                            ? relativeTime(a.updated_src)
                            : "unknown"}{" "}
                          · fetched {relativeTime(a.fetched_at)}
                        </span>
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          Suggested questions ({questions.length})
                        </p>
                        {questions.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            None returned.
                          </p>
                        ) : (
                          <ul className="list-disc space-y-0.5 pl-4 text-sm">
                            {questions.slice(0, 8).map((q) => (
                              <li key={q}>{q}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          Competitors analysed ({competitors.length})
                        </p>
                        {competitors.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            None returned.
                          </p>
                        ) : (
                          <ul className="space-y-0.5 text-sm">
                            {competitors.slice(0, 6).map((c, i) => (
                              <li key={`${c.url}-${i}`} className="truncate">
                                {c.title ?? c.url ?? "Untitled"}
                                {c.contentScore != null && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · score {c.contentScore}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Target page: not stated by the API. Pair this keyword with
                      the right page in Opportunities.
                    </p>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
