import { NavLink, Outlet, useSearchParams } from "react-router-dom";
import { useSites } from "@/lib/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { RANGES } from "@/features/keywords/opportunity-meta";

export interface KeywordsOutletContext {
  siteId: string;
  days: number;
}

const TABS = [
  { to: "", label: "Overview" },
  { to: "opportunities", label: "Opportunities" },
  { to: "rankings", label: "Rankings" },
  { to: "queries", label: "Queries" },
  { to: "pages", label: "Pages" },
  { to: "clusters", label: "Clusters" },
];

/**
 * Shared shell for every Keywords screen: a site selector + date range
 * (persisted in the URL so switching tabs keeps the same site/window), and
 * the sub-navigation. Each page reads { siteId, days } via useOutletContext.
 */
export function KeywordsLayout() {
  const sitesQuery = useSites();
  const [params, setParams] = useSearchParams();

  if (sitesQuery.isLoading) return <Skeleton className="h-64" />;

  const sites = (sitesQuery.data ?? []).filter((s) => s.is_active);
  if (sites.length === 0) {
    return (
      <EmptyState
        title="No sites yet"
        description="Add a website in Sites before keyword intelligence has anything to work with."
      />
    );
  }

  const siteId =
    params.get("site") && sites.some((s) => s.id === params.get("site"))
      ? (params.get("site") as string)
      : sites[0].id;
  const days = Number(params.get("days")) || 28;

  function setSite(id: string) {
    const next = new URLSearchParams(params);
    next.set("site", id);
    setParams(next, { replace: true });
  }
  function setDays(d: number) {
    const next = new URLSearchParams(params);
    next.set("days", String(d));
    setParams(next, { replace: true });
  }

  const query = `?site=${siteId}&days=${days}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Keywords</h1>
          <p className="text-sm text-muted-foreground">
            Opportunity detection from Search Console (and Bing where connected)
            - no paid keyword data.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <div className="inline-flex rounded-md border border-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition-colors",
                  days === r
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r}d
              </button>
            ))}
          </div>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={`/keywords/${tab.to}${query}`}
            end={tab.to === ""}
            className={({ isActive }) =>
              cn(
                "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ siteId, days } satisfies KeywordsOutletContext} />
    </div>
  );
}
