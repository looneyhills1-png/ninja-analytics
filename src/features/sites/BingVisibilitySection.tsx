// Bing visibility & discovery section (2026-09-24 brief PART 2) - the
// dashboard the brief asked for: distinguishes Bing impressions/clicks/CTR
// (already tracked, from search_daily), Bing query/page data (now populated
// - see _shared/bing.ts), sitemap reachability, IndexNow submission history,
// and indexed/discovered info (GetCrawlStats). Every field here is either a
// real number from the database/site, or an explicit "not available" state -
// never a zero standing in for missing data (CLAUDE.md: "Missing data must
// remain missing/unknown").
import { useEffect, useState } from "react";
import { useSiteBingVisibility } from "@/lib/hooks";
import {
  fetchIndexNowStatus,
  fetchSitemapStatus,
  type IndexNowStatus,
  type SitemapStatus,
} from "@/features/sites/bing-discovery-source";
import type { TermRow } from "@/lib/search-terms";
import { Card } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCtr, formatNumber, formatPosition } from "@/lib/format";
import { relativeTime } from "@/lib/dates";

const DASH = "—";

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

function MiniTermsTable({
  title,
  rows,
  emptyReason,
}: {
  title: string;
  rows: TermRow[];
  emptyReason: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyReason}</p>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {rows.slice(0, 8).map((row) => (
                  <tr
                    key={row.key}
                    className="border-b border-border last:border-0"
                  >
                    <td
                      className="max-w-[16rem] truncate px-3 py-1.5"
                      title={row.key}
                    >
                      {shortPath(row.key) === row.key
                        ? row.key
                        : shortPath(row.key)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {formatNumber(row.clicks)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {formatNumber(row.impressions)} impr.
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {formatPosition(row.position)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}

function IndexNowCard({ status }: { status: IndexNowStatus | null }) {
  if (!status) return <Skeleton className="h-32" />;
  if (!status.available) {
    return (
      <Card className="p-4">
        <h3 className="text-xs font-semibold text-muted-foreground">
          IndexNow submissions
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Not available - the site hasn&apos;t published an IndexNow submission
          log at /assets/data/indexnow-submission-log.json (or it isn&apos;t
          reachable cross-origin). This is not the same as &quot;zero
          submissions.&quot;
        </p>
      </Card>
    );
  }
  const latest = status.latest;
  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold text-muted-foreground">
        IndexNow submissions
      </h3>
      {!latest ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Log reachable, no runs recorded yet.
        </p>
      ) : (
        <div className="mt-2 space-y-1 text-sm">
          <p>
            Last run {relativeTime(latest.submittedAt)}:{" "}
            <span className={latest.allOk ? "text-success" : "text-warning"}>
              {latest.allOk
                ? "all batches OK"
                : `${latest.failedUrlCount} URL(s) failed`}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {latest.submittableCount} submitted this run ({latest.added} new,{" "}
            {latest.changed} changed, {latest.removed} removed)
            {latest.rejectedCount > 0
              ? `, ${latest.rejectedCount} rejected as non-submittable`
              : ""}
            .
          </p>
          {latest.batches.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {latest.batches.map((b, i) => (
                <li key={i}>
                  Batch {i + 1}: {b.urlCount} URL(s) -{" "}
                  {b.ok
                    ? `HTTP ${b.status ?? DASH} OK`
                    : `FAILED (${b.status ?? b.error ?? "unknown"})`}
                  {b.attemptsMade > 1
                    ? ` after ${b.attemptsMade} attempts`
                    : ""}
                </li>
              ))}
            </ul>
          )}
          <p className="pt-1 text-[11px] text-muted-foreground">
            A 2xx response means Bing accepted the request, not that the URL is
            confirmed indexed - see crawl/index health below.
          </p>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Last {status.submissions.length} run(s) recorded.
      </p>
    </Card>
  );
}

function SitemapCard({ status }: { status: SitemapStatus | null }) {
  if (!status) return <Skeleton className="h-20" />;
  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold text-muted-foreground">Sitemap</h3>
      {status.available ? (
        <p className="mt-2 text-sm">
          Live at /sitemap.xml with {formatNumber(status.urlCount)} URL(s).
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Not reachable this run - could not confirm sitemap.xml.
        </p>
      )}
    </Card>
  );
}

export function BingVisibilitySection({
  siteId,
  domain,
  days,
}: {
  siteId: string;
  domain: string;
  days: number;
}) {
  const { data, isLoading, isError } = useSiteBingVisibility(siteId, days);
  const [indexNow, setIndexNow] = useState<IndexNowStatus | null>(null);
  const [sitemap, setSitemap] = useState<SitemapStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchIndexNowStatus(domain).then((s) => {
      if (!cancelled) setIndexNow(s);
    });
    fetchSitemapStatus(domain).then((s) => {
      if (!cancelled) setSitemap(s);
    });
    return () => {
      cancelled = true;
    };
  }, [domain]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (isError || !data) return null; // non-critical; the rest of the page still works

  const latestCrawl = data.latestCrawlHealth;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Bing visibility &amp; discovery</h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <SitemapCard status={sitemap} />
        <IndexNowCard status={indexNow} />
        <Card className="p-4">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Bing crawl / index health
          </h3>
          {!latestCrawl ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Not available - Bing has not returned GetCrawlStats data for this
              site yet.
            </p>
          ) : (
            <div className="mt-2 space-y-1 text-sm">
              <p>
                {formatNumber(latestCrawl.in_index)} page(s) in Bing&apos;s
                index as of {latestCrawl.metric_date}.
              </p>
              <p className="text-xs text-muted-foreground">
                {formatNumber(latestCrawl.crawled_pages)} crawled that day
                {latestCrawl.blocked_by_robots_txt
                  ? `, ${latestCrawl.blocked_by_robots_txt} blocked by robots.txt`
                  : ""}
                {latestCrawl.crawl_errors
                  ? `, ${latestCrawl.crawl_errors} crawl error(s)`
                  : ""}
                .
              </p>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          label="Bing query data"
          value={data.queryDataEverAvailable ? "Available" : "Not available"}
          hint={
            data.queryDataEverAvailable
              ? `${data.queries.length} quer${data.queries.length === 1 ? "y" : "ies"} in the last ${days} days`
              : "Bing hasn't returned per-query data for this site yet - this is separate from the daily impressions/clicks totals above."
          }
        />
        <StatCard
          label="Bing page data"
          value={data.pageDataEverAvailable ? "Available" : "Not available"}
          hint={
            data.pageDataEverAvailable
              ? `${data.pages.length} page${data.pages.length === 1 ? "" : "s"} in the last ${days} days`
              : "Bing hasn't returned per-page data for this site yet."
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <MiniTermsTable
          title="Top Bing queries"
          rows={data.queries}
          emptyReason={
            data.queryDataEverAvailable
              ? "No Bing query rows in this window."
              : "No Bing query data available for this site."
          }
        />
        <MiniTermsTable
          title="Top Bing pages"
          rows={data.pages}
          emptyReason={
            data.pageDataEverAvailable
              ? "No Bing page rows in this window."
              : "No Bing page data available for this site."
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Bing CTR/average position figures above are computed locally from
        clicks/impressions where available - Bing&apos;s own API doesn&apos;t
        return CTR directly. {formatCtr(null)} means not computable (zero
        impressions), never zero.
      </p>
    </section>
  );
}
