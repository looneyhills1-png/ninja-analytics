import { useGa4Breakdowns, useGa4Realtime } from "@/lib/hooks";
import { formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

function RankedList({
  rows,
  empty,
}: {
  rows: Array<{ label: string; value: number }>;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm"
        >
          <span className="truncate" title={row.label}>
            {row.label}
          </span>
          <span className="font-medium tabular-nums">{formatNumber(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function Ga4ExplorerSection({
  siteId,
  days,
}: {
  siteId: string;
  days: number;
}) {
  const breakdowns = useGa4Breakdowns(siteId, days);
  const realtime = useGa4Realtime(siteId);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">GA4 audience &amp; acquisition</h2>
        <p className="text-xs text-muted-foreground">
          The same high-value views surfaced on the GA4 home screen, inside Ninja Analytics.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Active users · last 30 minutes</CardTitle>
          </CardHeader>
          <CardContent>
            {realtime.isLoading ? (
              <Skeleton className="h-24" />
            ) : realtime.isError ? (
              <ErrorState onRetry={() => void realtime.refetch()} />
            ) : (
              <div className="space-y-3">
                <p className="text-3xl font-semibold tabular-nums">
                  {formatNumber(realtime.data?.activeUsers ?? 0)}
                </p>
                <RankedList
                  rows={realtime.data?.countries ?? []}
                  empty="No realtime country data right now."
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Active users by country · {days}d</CardTitle>
          </CardHeader>
          <CardContent>
            {breakdowns.isLoading ? (
              <Skeleton className="h-40" />
            ) : breakdowns.isError ? (
              <ErrorState onRetry={() => void breakdowns.refetch()} />
            ) : (
              <RankedList
                rows={breakdowns.data?.countries ?? []}
                empty="No country breakdown stored yet. Run a GA4 sync."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Views by page title · {days}d</CardTitle>
          </CardHeader>
          <CardContent>
            {breakdowns.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <RankedList
                rows={breakdowns.data?.pages ?? []}
                empty="No page-title breakdown stored yet. Run a GA4 sync."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sessions by channel · {days}d</CardTitle>
          </CardHeader>
          <CardContent>
            {breakdowns.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <RankedList
                rows={breakdowns.data?.channels ?? []}
                empty="No acquisition-channel breakdown stored yet. Run a GA4 sync."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
