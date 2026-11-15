import { useState } from "react";
import { Link } from "react-router-dom";
import { Pencil, Plus } from "lucide-react";
import { useSites } from "@/lib/hooks";
import type { SiteWithStatuses } from "@/lib/api";
import { computeHealth } from "@/lib/health";
import { SOURCES, SOURCE_SHORT } from "@/lib/sources";
import { relativeTime } from "@/lib/dates";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HealthBadge } from "@/components/status/HealthBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SiteFormDialog } from "@/features/sites/SiteFormDialog";
import { usePrivacyMode } from "@/lib/privacy";

export function SitesPage() {
  const privacy = usePrivacyMode();
  const { data: sites, isLoading, isError, refetch } = useSites();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SiteWithStatuses | null>(null);
  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Sites</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every managed website and its integration health.
          </p>
        </div>
        <Button
          help="Adds a website for Ninja Analytics to monitor. Saved here only."
          effect="data"
          size="sm"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add site
        </Button>
      </div>

      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      )}

      {isError && <ErrorState onRetry={() => void refetch()} />}

      {sites && sites.length === 0 && (
        <EmptyState
          title="No websites yet"
          description="Add your first site to start tracking its metrics."
          action={
            <Button
              help="Adds a website for Ninja Analytics to monitor. Saved here only."
              effect="data"
              size="sm"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add site
            </Button>
          }
        />
      )}

      {sites && sites.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {sites.map((site) => (
            <div key={site.id} className="relative">
              <Button
                help="Edits this site's name, domain and connected Google and Bing accounts."
                effect="data"
                variant="ghost"
                size="sm"
                className="absolute right-2 top-2 z-10"
                aria-label={`Edit ${site.name}`}
                onClick={() => setEditing(site)}
              >
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
              <Link to={`/sites/${site.id}`} className="block">
                <Card className="h-full transition-colors hover:border-primary/50">
                  <CardContent className="space-y-3 p-4">
                    <div>
                      <p className="font-medium">
                        {privacy.maskText(site.name, `site:${site.id}:name`)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {privacy.maskText(
                          site.domain,
                          `site:${site.id}:domain`,
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {SOURCES.map((source) => {
                        const status = site.statuses.find(
                          (s) => s.source === source,
                        );
                        if (!status) return null;
                        const health = computeHealth(status, now);
                        return (
                          <div
                            key={source}
                            className="flex items-center gap-1.5"
                          >
                            <span className="text-xs text-muted-foreground">
                              {SOURCE_SHORT[source]}
                            </span>
                            <HealthBadge health={health} />
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last success{" "}
                      {privacy.enabled
                        ? "********"
                        : relativeTime(
                            site.statuses
                              .map((s) => s.last_success_at)
                              .filter((d): d is string => !!d)
                              .sort()
                              .at(-1),
                          )}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <SiteFormDialog
          key={editing.id}
          mode="edit"
          site={editing}
          onClose={() => setEditing(null)}
          onDeleted={() => setEditing(null)}
        />
      )}

      {adding && (
        <SiteFormDialog mode="create" onClose={() => setAdding(false)} />
      )}
    </div>
  );
}
