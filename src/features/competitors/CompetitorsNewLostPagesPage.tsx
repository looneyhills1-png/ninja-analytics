import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  DomainPicker,
  useDomainOptions,
} from "@/features/competitors/domain-picker";
import { useCommonCrawlPages } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import type { CompetitorsOutletContext } from "@/features/competitors/CompetitorsLayout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/** New pages (first seen in the most recent sync) and lost pages
 * (disappeared - no longer found in the latest Common Crawl snapshot) for a
 * tracked domain - the two views the brief calls out explicitly, as filtered
 * slices of the same cached common_crawl_pages table. */
export function CompetitorsNewLostPagesPage() {
  const { siteId } = useOutletContext<CompetitorsOutletContext>();
  const privacy = usePrivacyMode();
  const domains = useDomainOptions(siteId);
  const [domain, setDomain] = useState<string | null>(null);
  const activeDomain = domain ?? domains[0] ?? "";
  const pagesQuery = useCommonCrawlPages(activeDomain);

  const { newPages, lostPages } = useMemo(() => {
    const pages = pagesQuery.data ?? [];
    if (pages.length === 0) return { newPages: [], lostPages: [] };
    const latestSeen = pages.reduce(
      (max, p) => (p.last_seen > max ? p.last_seen : max),
      pages[0].last_seen,
    );
    return {
      newPages: pages.filter((p) => p.is_active && p.first_seen === latestSeen),
      lostPages: pages.filter((p) => !p.is_active),
    };
  }, [pagesQuery.data]);

  if (pagesQuery.isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      <DomainPicker domains={domains} value={domain} onChange={setDomain} />

      {(pagesQuery.data ?? []).length === 0 ? (
        <EmptyState
          title="No data cached yet"
          description="Sync this domain from Historical Pages first."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">
              New pages ({newPages.length})
            </h2>
            {newPages.length === 0 ? (
              <EmptyState title="No newly discovered pages in the latest sync" />
            ) : (
              <Card>
                <ul className="divide-y divide-border text-sm">
                  {newPages.slice(0, 100).map((p) => (
                    <li key={p.id} className="truncate px-3 py-2">
                      {privacy.enabled
                        ? privacy.maskText(p.url, `new-url:${p.id}`)
                        : shortPath(p.url)}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">
              Disappeared pages ({lostPages.length})
            </h2>
            {lostPages.length === 0 ? (
              <EmptyState title="No pages have disappeared" />
            ) : (
              <Card>
                <ul className="divide-y divide-border text-sm">
                  {lostPages.slice(0, 100).map((p) => (
                    <li
                      key={p.id}
                      className="truncate px-3 py-2 text-muted-foreground"
                    >
                      {privacy.enabled
                        ? privacy.maskText(p.url, `lost-url:${p.id}`)
                        : shortPath(p.url)}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
