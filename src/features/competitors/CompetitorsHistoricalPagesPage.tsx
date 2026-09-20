import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { RefreshCw, Info } from "lucide-react";
import {
  useCommonCrawlPages,
  useCommonCrawlRuns,
  useTriggerCommonCrawlSync,
} from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { CompetitorsOutletContext } from "@/features/competitors/CompetitorsLayout";
import {
  DomainPicker,
  useDomainOptions,
} from "@/features/competitors/domain-picker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/**
 * Common Crawl historical URLs (CLAUDE.md Phase 3) - zero-cost, one public
 * CDX snapshot per sync, cached in our own DB. Coverage is inherently
 * partial (Common Crawl doesn't index every page on every site) - that's
 * said plainly rather than implied as complete.
 */
export function CompetitorsHistoricalPagesPage() {
  const { siteId } = useOutletContext<CompetitorsOutletContext>();
  const privacy = usePrivacyMode();
  const domains = useDomainOptions(siteId);
  const [domain, setDomain] = useState<string | null>(null);
  const activeDomain = domain ?? domains[0] ?? "";

  const pagesQuery = useCommonCrawlPages(activeDomain);
  const runsQuery = useCommonCrawlRuns(activeDomain);
  const syncMutation = useTriggerCommonCrawlSync();

  const pages = pagesQuery.data ?? [];
  const activeCount = pages.filter((p) => p.is_active).length;
  const lastRun = runsQuery.data?.[0] ?? null;

  return (
    <div className="space-y-4">
      <Card className="border-primary/30 bg-primary/5">
        <div className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs text-muted-foreground">
            Sourced from Common Crawl's free public index (one monthly snapshot
            per sync) - never a full mirror, and coverage is inherently partial.
            History (new/disappeared) builds up from our own repeated syncs over
            time, not from Common Crawl's archive.
          </p>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <DomainPicker domains={domains} value={domain} onChange={setDomain} />
        <Button
          size="sm"
          variant="secondary"
          loading={syncMutation.isPending}
          disabled={!activeDomain}
          onClick={() => void syncMutation.mutate(activeDomain)}
        >
          <RefreshCw className="h-3.5 w-3.5" /> Sync now
        </Button>
        {syncMutation.data && (
          <span className="text-xs text-muted-foreground">
            Found {syncMutation.data.pagesFound}, new{" "}
            {syncMutation.data.pagesNew}, disappeared{" "}
            {syncMutation.data.pagesDisappeared}
          </span>
        )}
        {syncMutation.error && (
          <span className="text-xs text-critical">
            {syncMutation.error instanceof Error
              ? syncMutation.error.message
              : "Sync failed."}
          </span>
        )}
      </div>

      {domains.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Known pages" value={pages.length} />
          <StatCard label="Currently active" value={activeCount} />
          <StatCard label="Deactivated" value={pages.length - activeCount} />
          <StatCard
            label="Last sync"
            value={lastRun ? relativeTime(lastRun.started_at) : "Never"}
            hint={lastRun ? `Status: ${lastRun.status}` : undefined}
          />
        </div>
      )}

      {pagesQuery.isLoading ? (
        <Skeleton className="h-64" />
      ) : pages.length === 0 ? (
        <EmptyState
          title="No pages cached yet"
          description="Click Sync now to pull this domain's URLs from Common Crawl's public index."
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">URL</th>
                  <th className="px-2 py-2 font-medium">Title</th>
                  <th className="px-2 py-2 font-medium">First seen</th>
                  <th className="px-2 py-2 font-medium">Last seen</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {pages.slice(0, 200).map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="max-w-[16rem] truncate px-3 py-2">
                      {privacy.enabled
                        ? privacy.maskText(p.url, `cc-url:${p.id}`)
                        : shortPath(p.url)}
                    </td>
                    <td className="max-w-[14rem] truncate px-2 py-2 text-xs text-muted-foreground">
                      {p.title
                        ? privacy.maskText(p.title, `cc-title:${p.id}`)
                        : "-"}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {p.first_seen}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {p.last_seen}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                          p.is_active
                            ? "border-success/30 bg-success/10 text-success"
                            : "border-critical/30 bg-critical/10 text-critical",
                        )}
                      >
                        {p.is_active ? "Active" : "Disappeared"}
                      </span>
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
