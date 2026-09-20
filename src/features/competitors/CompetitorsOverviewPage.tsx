import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import {
  useAddCompetitorDomain,
  useCompetitorDomains,
  useObservedSerpResults,
  useRemoveCompetitorDomain,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { CompetitorsOutletContext } from "@/features/competitors/CompetitorsLayout";
import {
  computeCompetitorInsights,
  suggestCompetitorDomains,
  type KeywordGapCategory,
} from "@/lib/competitor-insights";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber, formatPosition } from "@/lib/format";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

const CATEGORY_LABEL: Record<KeywordGapCategory, string> = {
  missing: "Missing",
  unique: "Unique",
  stronger: "Stronger",
  weaker: "Weaker",
  shared: "Shared",
};

const CATEGORY_TONE: Record<KeywordGapCategory, string> = {
  missing: "border-critical/30 bg-critical/10 text-critical",
  unique: "border-violet-500/30 bg-violet-500/10 text-violet-500",
  stronger: "border-success/30 bg-success/10 text-success",
  weaker: "border-warning/30 bg-warning/10 text-warning",
  shared: "border-border text-muted-foreground",
};

/** Competitor domain management + the Observed Keyword Gap - explicitly
 * labelled "observed" throughout: this is built bottom-up from SERP checks
 * an admin has actually recorded, never a claim to Semrush's or anyone
 * else's complete keyword database. */
export function CompetitorsOverviewPage() {
  const { siteId } = useOutletContext<CompetitorsOutletContext>();
  const privacy = usePrivacyMode();
  const domainsQuery = useCompetitorDomains(siteId);
  const serpQuery = useObservedSerpResults(siteId);
  const addMutation = useAddCompetitorDomain(siteId);
  const removeMutation = useRemoveCompetitorDomain(siteId);

  const [domainInput, setDomainInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<
    KeywordGapCategory | "all"
  >("all");

  const competitors = useMemo(
    () =>
      (domainsQuery.data ?? []).map((c) => ({
        id: c.id,
        siteId: c.site_id,
        domain: c.domain,
        label: c.label,
        note: c.note,
        autoDiscovered: c.auto_discovered,
        createdAt: c.created_at,
      })),
    [domainsQuery.data],
  );
  const serpResults = useMemo(
    () =>
      (serpQuery.data ?? []).map((r) => ({
        id: r.id,
        siteId: r.site_id,
        query: r.query,
        engine: r.engine,
        observedAt: r.observed_at,
        domain: r.domain,
        url: r.url,
        rankObserved: r.rank_observed,
        isOwnSite: r.is_own_site,
      })),
    [serpQuery.data],
  );

  const insights = useMemo(
    () => computeCompetitorInsights(competitors, serpResults),
    [competitors, serpResults],
  );
  const suggestions = useMemo(
    () => suggestCompetitorDomains(competitors, serpResults),
    [competitors, serpResults],
  );

  const activeInsight =
    insights.find((i) => i.domain === selectedDomain) ?? insights[0] ?? null;

  async function handleAdd(domain: string, autoDiscovered = false) {
    if (!domain.trim()) return;
    await addMutation.mutateAsync({
      siteId,
      domain: domain.trim(),
      label: labelInput.trim() || null,
      note: null,
      autoDiscovered,
    });
    setDomainInput("");
    setLabelInput("");
  }

  if (domainsQuery.isLoading || serpQuery.isLoading)
    return <Skeleton className="h-96" />;
  if (domainsQuery.isError || serpQuery.isError)
    return <ErrorState onRetry={() => void domainsQuery.refetch()} />;

  const gapRows = activeInsight
    ? categoryFilter === "all"
      ? activeInsight.gap
      : activeInsight.gap.filter((g) => g.category === categoryFilter)
    : [];

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-end gap-2 p-4">
          <input
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            placeholder="competitor-domain.com"
            className="h-9 w-56 rounded-md border border-border bg-card px-3 text-sm"
          />
          <input
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            placeholder="Label (optional)"
            className="h-9 w-40 rounded-md border border-border bg-card px-3 text-sm"
          />
          <Button
            size="sm"
            loading={addMutation.isPending}
            onClick={() => void handleAdd(domainInput)}
          >
            <Plus className="h-3.5 w-3.5" /> Add competitor
          </Button>
        </div>
        {addMutation.error && (
          <p className="px-4 pb-3 text-xs text-critical">
            {addMutation.error instanceof Error
              ? addMutation.error.message
              : "Could not save."}
          </p>
        )}
      </Card>

      {suggestions.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <div className="p-4">
            <p className="text-sm font-medium">Suggested from observed SERPs</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              These domains have shown up repeatedly in SERP observations you've
              recorded but aren't tracked yet.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.domain}
                  type="button"
                  onClick={() => void handleAdd(s.domain, true)}
                  className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-xs hover:border-primary/50"
                >
                  <Plus className="h-3 w-3" />
                  {privacy.maskText(s.domain, `comp-suggest:${s.domain}`)}
                  <span className="text-muted-foreground">
                    &middot; seen {s.appearanceCount}x
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {insights.length === 0 ? (
        <EmptyState
          title="No competitors tracked yet"
          description="Add a domain above, or record a full SERP observation from a tracked keyword in Keywords → Rankings to start building this data."
        />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
            {insights.map((insight) => (
              <button
                key={insight.domain}
                type="button"
                onClick={() => setSelectedDomain(insight.domain)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  activeInsight?.domain === insight.domain
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">
                    {privacy.maskText(insight.domain, `comp:${insight.domain}`)}
                  </p>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Remove competitor"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeMutation.mutateAsync(insight.domain);
                    }}
                    className="text-muted-foreground hover:text-critical"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Seen {formatNumber(insight.appearanceCount)}x
                  {insight.autoDiscovered && " · auto-discovered"}
                </p>
                <div className="mt-2 flex gap-1 text-[10px]">
                  <span className="rounded border border-success/30 bg-success/10 px-1 text-success">
                    {insight.strongerCount} stronger
                  </span>
                  <span className="rounded border border-warning/30 bg-warning/10 px-1 text-warning">
                    {insight.weakerCount} weaker
                  </span>
                </div>
              </button>
            ))}
          </div>

          {activeInsight && (
            <section className="space-y-3">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <StatCard
                  label="Shared"
                  value={formatNumber(activeInsight.sharedCount)}
                />
                <StatCard
                  label="Stronger"
                  value={formatNumber(activeInsight.strongerCount)}
                />
                <StatCard
                  label="Weaker"
                  value={formatNumber(activeInsight.weakerCount)}
                />
                <StatCard
                  label="Missing"
                  value={formatNumber(activeInsight.missingCount)}
                />
                <StatCard
                  label="Unique"
                  value={formatNumber(activeInsight.uniqueCount)}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  Observed Keyword Gap vs.{" "}
                  {privacy.maskText(
                    activeInsight.domain,
                    `comp-gap:${activeInsight.domain}`,
                  )}
                </h2>
                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      "all",
                      "shared",
                      "stronger",
                      "weaker",
                      "missing",
                      "unique",
                    ] as const
                  ).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategoryFilter(c)}
                      className={cn(
                        "rounded border px-2 py-1 text-xs font-medium",
                        categoryFilter === c
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {c === "all" ? "All" : CATEGORY_LABEL[c]}
                    </button>
                  ))}
                </div>
              </div>

              {gapRows.length === 0 ? (
                <EmptyState title="No observed data for this filter yet" />
              ) : (
                <Card>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Query</th>
                          <th className="px-2 py-2 font-medium">Category</th>
                          <th className="px-2 py-2 text-right font-medium">
                            Our rank
                          </th>
                          <th className="px-2 py-2 font-medium">Our URL</th>
                          <th className="px-2 py-2 text-right font-medium">
                            Competitor rank
                          </th>
                          <th className="px-2 py-2 font-medium">
                            Competitor URL
                          </th>
                          <th className="px-2 py-2 font-medium">
                            Last observed
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {gapRows.map((g) => (
                          <tr
                            key={`${g.query}:${g.engine}`}
                            className="border-b border-border last:border-0"
                          >
                            <td className="max-w-[12rem] truncate px-3 py-2">
                              {privacy.maskText(g.query, `gap-q:${g.query}`)}
                            </td>
                            <td className="px-2 py-2">
                              <span
                                className={cn(
                                  "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                                  CATEGORY_TONE[g.category],
                                )}
                              >
                                {CATEGORY_LABEL[g.category]}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {formatPosition(g.ourRank)}
                            </td>
                            <td className="max-w-[10rem] truncate px-2 py-2 text-xs text-muted-foreground">
                              {g.ourUrl
                                ? privacy.maskText(
                                    g.ourUrl,
                                    `gap-ourl:${g.query}`,
                                  )
                                : "-"}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {formatPosition(g.competitorRank)}
                            </td>
                            <td className="max-w-[10rem] truncate px-2 py-2 text-xs text-muted-foreground">
                              {g.competitorUrl
                                ? privacy.maskText(
                                    g.competitorUrl,
                                    `gap-curl:${g.query}`,
                                  )
                                : "-"}
                            </td>
                            <td className="px-2 py-2 text-xs text-muted-foreground">
                              {relativeTime(g.lastObservedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
