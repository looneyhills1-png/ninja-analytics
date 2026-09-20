import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Info, Plus, Sparkles, Trash2 } from "lucide-react";
import {
  useAddAiVisibilityPrompt,
  useAiVisibilityObservations,
  useAiVisibilityPrompts,
  useRecordAiVisibilityObservation,
  useRemoveAiVisibilityPrompt,
  useSearchAppearanceDaily,
  useSiteSearchTerms,
  useSites,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import { AI_SOURCES, type AiVisibilitySource } from "@/lib/ai-search-sources";
import {
  computePromptStatuses,
  computeSourceCoverage,
  generatePromptSuggestions,
  type AiVisibilityObservationRow,
} from "@/lib/ai-visibility-insights";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCtr, formatNumber, formatPosition } from "@/lib/format";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

const TABS = ["coverage", "prompts", "observations"] as const;
type Tab = (typeof TABS)[number];

/** AI-related search-appearance heuristic: Google hasn't published a fixed
 * enum, so this matches on the value looking AI/generative-related rather
 * than assuming an exact string (see search_appearance_daily's comment). */
function looksAiRelated(value: string): boolean {
  return /ai|generative|overview/i.test(value);
}

export function AiVisibilityPage() {
  const privacy = usePrivacyMode();
  const sitesQuery = useSites();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("coverage");

  const sites = (sitesQuery.data ?? []).filter((s) => s.is_active);
  const siteId =
    params.get("site") && sites.some((s) => s.id === params.get("site"))
      ? (params.get("site") as string)
      : (sites[0]?.id ?? "");

  function setSite(id: string) {
    const next = new URLSearchParams(params);
    next.set("site", id);
    setParams(next, { replace: true });
  }

  const promptsQuery = useAiVisibilityPrompts(siteId);
  const observationsQuery = useAiVisibilityObservations(siteId);
  const appearanceQuery = useSearchAppearanceDaily(siteId, 28);
  const searchTermsQuery = useSiteSearchTerms(siteId, 28);

  const prompts = useMemo(
    () =>
      (promptsQuery.data ?? []).map((p) => ({
        id: p.id,
        siteId: p.site_id,
        promptText: p.prompt_text,
        category: p.category,
        sourceQuery: p.source_query,
        createdAt: p.created_at,
      })),
    [promptsQuery.data],
  );
  const observations = useMemo(
    () =>
      (observationsQuery.data ?? []).map((o) => ({
        id: o.id,
        siteId: o.site_id,
        promptId: o.prompt_id,
        promptText: o.prompt_text,
        source: o.source,
        observedAt: o.observed_at,
        isCited: o.is_cited,
        citedUrl: o.cited_url,
        competitorDomain: o.competitor_domain,
        country: o.country,
        device: o.device,
        notes: o.notes,
      })),
    [observationsQuery.data],
  );

  const coverage = useMemo(
    () => computeSourceCoverage(observations),
    [observations],
  );
  const promptStatuses = useMemo(
    () => computePromptStatuses(prompts, observations),
    [prompts, observations],
  );

  const aiAppearanceRows = useMemo(
    () =>
      (appearanceQuery.data ?? []).filter((r) =>
        looksAiRelated(r.search_appearance),
      ),
    [appearanceQuery.data],
  );

  if (sitesQuery.isLoading) return <Skeleton className="h-64" />;
  if (sites.length === 0) {
    return (
      <EmptyState
        title="No sites yet"
        description="Add a website in Sites before AI visibility has anything to track."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">AI Visibility</h1>
          <p className="text-sm text-muted-foreground">
            Coverage across ChatGPT, Gemini, Copilot, Claude, Siri, Alexa,
            Yahoo, DuckDuckGo, Brave, Ecosia, Dogpile, Perplexity and more -
            mostly via manual/on-demand tests, since none of them expose a free
            per-site query or citation API.
          </p>
        </div>
        <select
          value={siteId}
          onChange={(e) => setSite(e.target.value)}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <nav className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium capitalize transition-colors",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === "coverage" && (
        <CoverageTab
          coverage={coverage}
          aiAppearanceRows={aiAppearanceRows}
          appearanceLoading={appearanceQuery.isLoading}
        />
      )}
      {tab === "prompts" && (
        <PromptsTab
          siteId={siteId}
          prompts={promptStatuses}
          isLoading={promptsQuery.isLoading}
          searchTerms={searchTermsQuery.data?.queries ?? []}
          privacyMask={(text: string, key: string) =>
            privacy.enabled ? privacy.maskText(text, key) : text
          }
        />
      )}
      {tab === "observations" && (
        <ObservationsTab
          siteId={siteId}
          prompts={prompts}
          observations={observations}
          isLoading={observationsQuery.isLoading}
        />
      )}
    </div>
  );
}

function CoverageTab({
  coverage,
  aiAppearanceRows,
  appearanceLoading,
}: {
  coverage: ReturnType<typeof computeSourceCoverage>;
  aiAppearanceRows: {
    metric_date: string;
    search_appearance: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    average_position: number | null;
  }[];
  appearanceLoading: boolean;
}) {
  return (
    <div className="space-y-4">
      <Card className="border-primary/30 bg-primary/5">
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs text-muted-foreground">
            Capability levels are a fact about each platform, not something this
            app measured: 1 = direct first-party query data, 2 =
            webmaster/analytics visibility data, 3 = public/free API or lawful
            observation, 4 = manual/on-demand test only, 5 = no reliable free
            access.
          </p>
        </div>
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-2 py-2 text-center font-medium">
                  Capability
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  Observations
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  Citation rate
                </th>
                <th className="px-2 py-2 font-medium">Last observed</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((c) => {
                const info = AI_SOURCES.find((s) => s.source === c.source)!;
                return (
                  <tr
                    key={c.source}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-3 py-2" title={info.notes}>
                      {info.label}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                          info.capability <= 2
                            ? "border-success/30 bg-success/10 text-success"
                            : info.capability === 3
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : info.capability === 4
                                ? "border-warning/30 bg-warning/10 text-warning"
                                : "border-border text-muted-foreground",
                        )}
                      >
                        {info.capability} &middot; {info.capabilityLabel}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatNumber(c.observationCount)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {c.citationRate == null
                        ? "-"
                        : `${Math.round(c.citationRate * 100)}%`}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {c.lastObservedAt
                        ? relativeTime(c.lastObservedAt)
                        : "Never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">
          Google AI-feature search appearances (GSC, best-effort)
        </h2>
        <p className="text-xs text-muted-foreground">
          Google hasn't published a fixed name for AI-feature search
          appearances, so this matches any search-appearance value that looks
          AI/generative-related - a heuristic, not a guaranteed complete filter.
        </p>
        {appearanceLoading ? (
          <Skeleton className="h-32" />
        ) : aiAppearanceRows.length === 0 ? (
          <EmptyState
            title="No AI-related search appearances detected yet"
            description="Either GSC hasn't reported any for this window, or this site's search-appearance breakdown hasn't synced yet."
          />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-2 py-2 font-medium">Search appearance</th>
                    <th className="px-2 py-2 text-right font-medium">Clicks</th>
                    <th className="px-2 py-2 text-right font-medium">Impr.</th>
                    <th className="px-2 py-2 text-right font-medium">CTR</th>
                    <th className="px-2 py-2 text-right font-medium">
                      Avg. pos.
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aiAppearanceRows.slice(0, 100).map((r, i) => (
                    <tr
                      key={i}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.metric_date}
                      </td>
                      <td className="px-2 py-2">{r.search_appearance}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatNumber(r.clicks)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {formatNumber(r.impressions)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCtr(r.ctr)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatPosition(r.average_position)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}

function PromptsTab({
  siteId,
  prompts,
  isLoading,
  searchTerms,
  privacyMask,
}: {
  siteId: string;
  prompts: ReturnType<typeof computePromptStatuses>;
  isLoading: boolean;
  searchTerms: { key: string; impressions: number }[];
  privacyMask: (text: string, key: string) => string;
}) {
  const addMutation = useAddAiVisibilityPrompt(siteId);
  const removeMutation = useRemoveAiVisibilityPrompt(siteId);
  const [promptText, setPromptText] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = useMemo(
    () =>
      generatePromptSuggestions(
        searchTerms.map((t) => ({ query: t.key, impressions: t.impressions })),
        10,
      ),
    [searchTerms],
  );

  async function handleAdd() {
    if (!promptText.trim()) return;
    await addMutation.mutateAsync({
      siteId,
      promptText: promptText.trim(),
      category: "observed",
      sourceQuery: null,
    });
    setPromptText("");
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-2 p-4">
          <input
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder="A real query/prompt to track..."
            className="h-9 w-72 rounded-md border border-border bg-card px-3 text-sm"
          />
          <Button
            size="sm"
            loading={addMutation.isPending}
            onClick={() => void handleAdd()}
          >
            <Plus className="h-3.5 w-3.5" /> Add as observed
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowSuggestions((s) => !s)}
          >
            <Sparkles className="h-3.5 w-3.5" /> Generate from top queries
          </Button>
        </div>
      </Card>

      {showSuggestions && (
        <Card className="border-primary/30 bg-primary/5">
          <div className="space-y-2 p-4">
            <p className="text-xs text-muted-foreground">
              Synthesised from this site's own top GSC queries - clearly
              labelled "generated" opportunities, never claimed as real prompts
              anyone typed into an AI assistant.
            </p>
            {suggestions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No query data available yet to generate from.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s.promptText}
                    type="button"
                    onClick={() =>
                      void addMutation.mutateAsync({
                        siteId,
                        promptText: s.promptText,
                        category: "generated",
                        sourceQuery: s.sourceQuery,
                      })
                    }
                    className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-xs hover:border-primary/50"
                  >
                    <Plus className="h-3 w-3" />
                    {privacyMask(s.promptText, `ai-suggest:${s.promptText}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-48" />
      ) : prompts.length === 0 ? (
        <EmptyState
          title="No prompts tracked yet"
          description="Add an observed query above, or generate candidate prompts from your top queries."
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Prompt</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 text-right font-medium">
                    Sources tested
                  </th>
                  <th className="px-2 py-2 font-medium">Last tested</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {prompts.map(({ prompt, sourcesCovered, lastObservedAt }) => (
                  <tr
                    key={prompt.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="max-w-[20rem] truncate px-3 py-2">
                      {privacyMask(prompt.promptText, `ai-prompt:${prompt.id}`)}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                          prompt.category === "observed"
                            ? "border-success/30 bg-success/10 text-success"
                            : "border-violet-500/30 bg-violet-500/10 text-violet-500",
                        )}
                      >
                        {prompt.category}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {sourcesCovered.length}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {lastObservedAt ? relativeTime(lastObservedAt) : "Never"}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        aria-label="Remove prompt"
                        onClick={() =>
                          void removeMutation.mutateAsync(prompt.id)
                        }
                        className="text-muted-foreground hover:text-critical"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ObservationsTab({
  siteId,
  prompts,
  observations,
  isLoading,
}: {
  siteId: string;
  prompts: { id: string; promptText: string }[];
  observations: AiVisibilityObservationRow[];
  isLoading: boolean;
}) {
  const privacy = usePrivacyMode();
  const recordMutation = useRecordAiVisibilityObservation(siteId);
  const [promptId, setPromptId] = useState<string>("");
  const [freeText, setFreeText] = useState("");
  const [source, setSource] = useState<AiVisibilitySource>("chatgpt");
  const [isCited, setIsCited] = useState<"" | "yes" | "no">("");
  const [citedUrl, setCitedUrl] = useState("");
  const [notes, setNotes] = useState("");

  async function submit() {
    const promptText = promptId
      ? (prompts.find((p) => p.id === promptId)?.promptText ?? freeText)
      : freeText;
    if (!promptText.trim()) return;
    await recordMutation.mutateAsync({
      siteId,
      promptId: promptId || null,
      promptText: promptText.trim(),
      source,
      isCited: isCited === "" ? null : isCited === "yes",
      citedUrl: citedUrl.trim() || null,
      competitorDomain: null,
      country: null,
      device: null,
      notes: notes.trim() || null,
    });
    setFreeText("");
    setCitedUrl("");
    setNotes("");
    setIsCited("");
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-2 p-4">
          <p className="text-xs text-muted-foreground">
            Record what you actually saw when testing a prompt on an AI
            assistant - a manual/on-demand test, since none of these platforms
            expose a free citation API.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <select
              value={promptId}
              onChange={(e) => setPromptId(e.target.value)}
              className="h-9 w-56 rounded-md border border-border bg-card px-2 text-sm"
            >
              <option value="">Free-text prompt...</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.promptText.slice(0, 60)}
                </option>
              ))}
            </select>
            {!promptId && (
              <input
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="Prompt text"
                className="h-9 w-64 rounded-md border border-border bg-card px-3 text-sm"
              />
            )}
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as AiVisibilitySource)}
              className="h-9 rounded-md border border-border bg-card px-2 text-sm"
            >
              {AI_SOURCES.map((s) => (
                <option key={s.source} value={s.source}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              value={isCited}
              onChange={(e) => setIsCited(e.target.value as "" | "yes" | "no")}
              className="h-9 rounded-md border border-border bg-card px-2 text-sm"
            >
              <option value="">Cited? Unknown</option>
              <option value="yes">Cited: Yes</option>
              <option value="no">Cited: No</option>
            </select>
            <input
              value={citedUrl}
              onChange={(e) => setCitedUrl(e.target.value)}
              placeholder="Cited URL (optional)"
              className="h-9 w-56 rounded-md border border-border bg-card px-3 text-sm"
            />
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional)"
              className="h-9 w-56 rounded-md border border-border bg-card px-3 text-sm"
            />
            <Button
              size="sm"
              loading={recordMutation.isPending}
              onClick={() => void submit()}
            >
              Save observation
            </Button>
          </div>
          {recordMutation.error && (
            <p className="text-xs text-critical">
              {recordMutation.error instanceof Error
                ? recordMutation.error.message
                : "Could not save."}
            </p>
          )}
        </div>
      </Card>

      {isLoading ? (
        <Skeleton className="h-48" />
      ) : observations.length === 0 ? (
        <EmptyState title="No observations recorded yet" />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Prompt</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                  <th className="px-2 py-2 font-medium">Cited?</th>
                  <th className="px-2 py-2 font-medium">Cited URL</th>
                  <th className="px-2 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {[...observations]
                  .sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))
                  .slice(0, 200)
                  .map((o) => (
                    <tr
                      key={o.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="max-w-[18rem] truncate px-3 py-2">
                        {privacy.maskText(o.promptText, `ai-obs:${o.id}`)}
                      </td>
                      <td className="px-2 py-2 text-xs">
                        {AI_SOURCES.find((s) => s.source === o.source)?.label ??
                          o.source}
                      </td>
                      <td className="px-2 py-2">
                        {o.isCited == null ? (
                          <span className="text-muted-foreground">Unknown</span>
                        ) : o.isCited ? (
                          <span className="text-success">Yes</span>
                        ) : (
                          <span className="text-critical">No</span>
                        )}
                      </td>
                      <td className="max-w-[12rem] truncate px-2 py-2 text-xs text-muted-foreground">
                        {o.citedUrl
                          ? privacy.maskText(o.citedUrl, `ai-obs-url:${o.id}`)
                          : "-"}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {relativeTime(o.observedAt)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
