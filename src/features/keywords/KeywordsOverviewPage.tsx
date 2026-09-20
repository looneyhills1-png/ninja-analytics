import { useMemo } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { useKeywordOpportunities } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { KeywordsOutletContext } from "@/features/keywords/KeywordsLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { OpportunityBadgeList } from "@/features/keywords/OpportunityBadges";
import { ScoreBar } from "@/features/keywords/ScoreBar";
import { formatPosition } from "@/lib/format";
import type { OpportunityCategory } from "@/lib/keyword-opportunities";

interface ActionCard {
  id: string;
  headline: string;
  detail: string;
  href: string;
}

function buildActionCards(
  rows: ReturnType<typeof useKeywordOpportunities>["data"],
): ActionCard[] {
  if (!rows) return [];
  const count = (cat: OpportunityCategory) =>
    rows.filter((r) => r.categories.includes(cat)).length;

  const strikeNow = count("strike-now");
  const lowCtr = count("high-impression-low-ctr");
  const falling = count("falling");
  const cannibalisation = count("cannibalisation");
  const newQueries = count("new");
  const lost = count("lost");
  const urlChanged = count("ranking-url-changed");

  const cards: ActionCard[] = [];
  if (strikeNow > 0) {
    cards.push({
      id: "strike-now",
      headline: `${strikeNow} keyword${strikeNow === 1 ? " is" : "s are"} within reach of page 1`,
      detail: "Ranking positions 4-10 with real search demand.",
      href: "opportunities?category=strike-now",
    });
  }
  if (lowCtr > 0) {
    cards.push({
      id: "low-ctr",
      headline: `${lowCtr} keyword${lowCtr === 1 ? " has" : "s have"} high impressions but weak CTR`,
      detail: "Titles/meta descriptions likely underselling the click.",
      href: "opportunities?category=high-impression-low-ctr",
    });
  }
  if (falling > 0) {
    cards.push({
      id: "falling",
      headline: `${falling} keyword${falling === 1 ? " is" : "s are"} losing clicks`,
      detail: "Recent decline vs the previous period.",
      href: "opportunities?category=falling",
    });
  }
  if (cannibalisation > 0) {
    cards.push({
      id: "cannibalisation",
      headline: `${cannibalisation} possible cannibalisation issue${cannibalisation === 1 ? "" : "s"}`,
      detail: "Multiple pages on this site competing for the same query.",
      href: "opportunities?category=cannibalisation",
    });
  }
  if (urlChanged > 0) {
    cards.push({
      id: "url-changed",
      headline: `${urlChanged} keyword${urlChanged === 1 ? "'s" : "s'"} ranking URL changed`,
      detail: "Worth confirming the new page is the right one.",
      href: "opportunities?category=ranking-url-changed",
    });
  }
  if (newQueries > 0) {
    cards.push({
      id: "new",
      headline: `${newQueries} newly discovered quer${newQueries === 1 ? "y" : "ies"}`,
      detail: "First appeared in the current window.",
      href: "opportunities?category=new",
    });
  }
  if (lost > 0) {
    cards.push({
      id: "lost",
      headline: `${lost} quer${lost === 1 ? "y" : "ies"} stopped appearing`,
      detail: "Had impressions previously, none in the current window.",
      href: "opportunities?category=lost",
    });
  }
  return cards;
}

export function KeywordsOverviewPage() {
  const { siteId, days } = useOutletContext<KeywordsOutletContext>();
  const privacy = usePrivacyMode();
  const opportunitiesQuery = useKeywordOpportunities(siteId, days);

  const actionCards = useMemo(
    () => buildActionCards(opportunitiesQuery.data),
    [opportunitiesQuery.data],
  );

  if (opportunitiesQuery.isLoading) return <Skeleton className="h-64" />;
  if (opportunitiesQuery.isError)
    return <ErrorState onRetry={() => void opportunitiesQuery.refetch()} />;

  const rows = opportunitiesQuery.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No query data yet"
        description="Keyword opportunities appear here once Search Console data has synced for this site."
      />
    );
  }

  const trackedPositions = rows.filter((r) => r.currentPosition != null);
  const avgPosition = trackedPositions.length
    ? trackedPositions.reduce((s, r) => s + (r.currentPosition ?? 0), 0) /
      trackedPositions.length
    : null;
  const brandedCount = rows.filter((r) => r.branded).length;
  const topOpportunities = rows.slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Tracked queries"
          value={rows.length.toLocaleString()}
        />
        <StatCard
          label="Avg. position"
          value={formatPosition(
            privacy.maskNumber(
              avgPosition,
              `kw-overview:${siteId}:${days}:pos`,
              {
                min: 1,
                max: 95,
                decimals: 1,
              },
            ),
          )}
        />
        <StatCard
          label="Branded queries"
          value={`${brandedCount.toLocaleString()} / ${rows.length.toLocaleString()}`}
        />
        <StatCard
          label="Non-branded"
          value={(rows.length - brandedCount).toLocaleString()}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">What to do next</h2>
        {actionCards.length === 0 ? (
          <EmptyState
            title="No urgent opportunities right now"
            description="Nothing crossed the thresholds for this window - check the full Opportunities table for the long tail."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {actionCards.map((card) => (
              <Link key={card.id} to={card.href}>
                <Card className="h-full transition-colors hover:border-primary/50">
                  <CardContent className="p-4">
                    <p className="text-sm font-semibold">{card.headline}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {card.detail}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Top opportunities</h2>
          <Link
            to="opportunities"
            className="text-xs text-primary hover:underline"
          >
            View all &rarr;
          </Link>
        </div>
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Query</th>
                  <th className="px-2 py-2 font-medium">Category</th>
                  <th className="px-2 py-2 text-right font-medium">Position</th>
                  <th className="px-2 py-2 text-right font-medium">Impr.</th>
                  <th className="px-2 py-2 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {topOpportunities.map((row) => (
                  <tr
                    key={row.query}
                    className="border-b border-border last:border-0"
                  >
                    <td className="max-w-[16rem] truncate px-3 py-2">
                      {privacy.maskText(row.query, `kw-overview:${row.query}`)}
                    </td>
                    <td className="px-2 py-2">
                      <OpportunityBadgeList
                        categories={row.categories}
                        max={2}
                      />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatPosition(row.currentPosition)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                      {row.impressions.toLocaleString()}
                    </td>
                    <td className="px-2 py-2">
                      <ScoreBar score={row.score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}
