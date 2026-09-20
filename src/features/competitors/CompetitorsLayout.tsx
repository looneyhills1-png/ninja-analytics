import { NavLink, Outlet, useSearchParams } from "react-router-dom";
import { useSites } from "@/lib/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

export interface CompetitorsOutletContext {
  siteId: string;
}

const TABS = [
  { to: "", label: "Overview" },
  { to: "historical-pages", label: "Historical Pages" },
  { to: "new-lost-pages", label: "New / Lost Pages" },
  { to: "links", label: "Links / Referring Pages" },
];

/**
 * Shared shell for the Competitors section: a site selector (persisted in
 * the URL) plus sub-navigation. Built on the existing competitor_domains /
 * observed_serp_results groundwork (0014) - "observed" everywhere here means
 * exactly that: built from SERP checks this app's admins actually recorded,
 * never a claim to a complete competitor-data index.
 */
export function CompetitorsLayout() {
  const sitesQuery = useSites();
  const [params, setParams] = useSearchParams();

  if (sitesQuery.isLoading) return <Skeleton className="h-64" />;

  const sites = (sitesQuery.data ?? []).filter((s) => s.is_active);
  if (sites.length === 0) {
    return (
      <EmptyState
        title="No sites yet"
        description="Add a website in Sites before competitor tracking has anything to work with."
      />
    );
  }

  const siteId =
    params.get("site") && sites.some((s) => s.id === params.get("site"))
      ? (params.get("site") as string)
      : sites[0].id;

  function setSite(id: string) {
    const next = new URLSearchParams(params);
    next.set("site", id);
    setParams(next, { replace: true });
  }

  const query = `?site=${siteId}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Competitors</h1>
          <p className="text-sm text-muted-foreground">
            Observed competitor discovery, built bottom-up from SERP checks
            you've recorded - not a complete keyword-data index.
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

      <nav className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={`/competitors/${tab.to}${query}`}
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

      <Outlet context={{ siteId } satisfies CompetitorsOutletContext} />
    </div>
  );
}
