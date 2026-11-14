import { useMemo } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { relativeTime } from "@/lib/dates";
import { formatNumber } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiReferrals, useCollectorStates, useRunIntel } from "./intel-api";
import { ProvenanceBadge } from "./Provenance";
import type { AiVisibilityObservation } from "@/types/database";

/** Verified and measured signals, kept visibly apart from sampled spot checks. */
export function AiSignalsTab({
  siteId,
  observations,
}: {
  siteId: string;
  observations: AiVisibilityObservation[];
}) {
  const referrals = useAiReferrals(siteId, 28);
  const collectors = useCollectorStates();
  const sync = useRunIntel("ai-referrals-sync");
  const ga4State = (collectors.data ?? []).find(
    (c) => c.provider === "ga4-ai-referrals",
  );

  const sampled = useMemo(() => {
    const byMethod = new Map<string, number>();
    let mentioned = 0;
    for (const o of observations) {
      byMethod.set(
        o.collection_method,
        (byMethod.get(o.collection_method) ?? 0) + 1,
      );
      if (o.brand_mentioned) mentioned += 1;
    }
    return {
      total: observations.length,
      mentioned,
      byMethod: [...byMethod.entries()],
    };
  }, [observations]);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          Platform reports (first-party)
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                Google AI Overviews and AI Mode
              </h3>
              <ProvenanceBadge kind="unsupported" />
            </div>
            <p className="text-sm text-muted-foreground">
              Search Console has a Search Generative AI performance report
              (impressions, pages, countries, devices; AI Overviews and AI Mode
              combined). As far as can be established it is not exposed through
              the Search Console API, so nothing is imported automatically.
            </p>
            <a
              className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
              href="https://search.google.com/search-console"
              target="_blank"
              rel="noreferrer"
            >
              Open Search Console{" "}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </Card>
          <Card className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                Bing AI Performance (Copilot citations)
              </h3>
              <ProvenanceBadge kind="manual" />
            </div>
            <p className="text-sm text-muted-foreground">
              Bing Webmaster Tools shows citations in its portal, but Microsoft
              has published no API for it. Record a snapshot by hand from the
              portal; see the Coverage tab. Nothing here is collected
              automatically.
            </p>
            <a
              className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
              href="https://www.bing.com/webmasters"
              target="_blank"
              rel="noreferrer"
            >
              Open Bing Webmaster Tools{" "}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">
              AI assistant referral traffic, last 28 days
            </h2>
            <ProvenanceBadge kind="measured" />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={sync.isPending}
            onClick={() => sync.mutate({})}
          >
            <RefreshCw
              className={sync.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              aria-hidden
            />
            Refresh from GA4
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Real visits recorded by GA4 whose source is an AI assistant (ChatGPT,
          Perplexity, Gemini, Copilot, Claude and similar). These are sessions,
          not impressions or citations, and assistants that send no referrer are
          not counted.
        </p>
        {typeof sync.data?.failed === "string" && (
          <p role="alert" className="text-sm text-critical">
            GA4 collection failed ({String(sync.data.failed)}). If Google access
            has expired, re-authorise Google; existing data below is unchanged.
          </p>
        )}
        {ga4State?.last_error_code && (
          <p className="text-xs text-warning">
            Last collection attempt{" "}
            {ga4State.last_attempt_at
              ? relativeTime(ga4State.last_attempt_at)
              : ""}{" "}
            failed ({ga4State.last_error_code}).
            {ga4State.last_success_at
              ? ` Last success ${relativeTime(ga4State.last_success_at)}.`
              : " It has never succeeded."}
          </p>
        )}
        {referrals.isLoading ? (
          <Skeleton className="h-24" />
        ) : (referrals.data?.totals ?? []).length === 0 ? (
          <Card className="p-4 text-sm text-muted-foreground">
            No AI-referral sessions recorded for this site in the period. That
            is either genuinely zero or not yet collected.
            {ga4State?.last_success_at
              ? ` Last successful collection ${relativeTime(ga4State.last_success_at)}.`
              : " Collection has not completed successfully yet."}
          </Card>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Assistant</th>
                  <th className="px-4 py-2 text-right font-medium">Sessions</th>
                  <th className="px-4 py-2 text-right font-medium">Users</th>
                  <th className="px-4 py-2 text-right font-medium">
                    Page views
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {referrals.data!.totals.map((t) => (
                  <tr key={t.provider}>
                    <td className="px-4 py-2">{t.provider}</td>
                    <td className="px-4 py-2 text-right">
                      {formatNumber(t.sessions)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {formatNumber(t.users)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {formatNumber(t.pageViews)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">
            Sampled observations (ChatGPT, Perplexity and others)
          </h2>
          <ProvenanceBadge kind="sampled" />
        </div>
        <Card className="space-y-1 p-4 text-sm">
          <p>
            {sampled.total === 0
              ? "No spot checks recorded yet."
              : `${sampled.total} spot check(s) recorded; the brand was mentioned in ${sampled.mentioned}.`}
          </p>
          {sampled.byMethod.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Collection methods:{" "}
              {sampled.byMethod.map(([m, n]) => `${m} (${n})`).join(", ")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            These are individual queries someone asked and recorded. They say
            nothing about platform-wide impressions, ranking or share of voice.
            Record them from the Observations tab; there is no automated
            querying of any assistant.
          </p>
        </Card>
      </section>
    </div>
  );
}
