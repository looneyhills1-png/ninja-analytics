import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  useRecordRankObservation,
  useRecordSerpObservation,
} from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SerpRow {
  domain: string;
  rankObserved: string;
  url: string;
  isOwnSite: boolean;
}

/**
 * Manual, on-demand rank observation - the zero-cost path CLAUDE.md and the
 * Phase 2 brief call for since a live automated Google rank check isn't
 * safely/practically available for free. Two modes:
 *  - Quick check: just our own site's rank/URL for this keyword.
 *  - Full SERP: every domain the admin actually saw on the results page,
 *    which is what feeds the Competitors / Observed Keyword Gap data.
 */
export function RecordObservationForm({
  siteId,
  trackedRankKeywordId,
  onSaved,
}: {
  siteId: string;
  trackedRankKeywordId: string;
  onSaved?: () => void;
}) {
  const [mode, setMode] = useState<"quick" | "serp">("quick");
  const quickMutation = useRecordRankObservation(siteId);
  const serpMutation = useRecordSerpObservation(siteId);

  const [quickUrl, setQuickUrl] = useState("");
  const [quickRank, setQuickRank] = useState("");
  const [notFound, setNotFound] = useState(false);

  const [serpRows, setSerpRows] = useState<SerpRow[]>([
    { domain: "", rankObserved: "", url: "", isOwnSite: true },
    { domain: "", rankObserved: "", url: "", isOwnSite: false },
  ]);

  function updateRow(index: number, patch: Partial<SerpRow>) {
    setSerpRows((rows) =>
      rows.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }

  async function submitQuick() {
    await quickMutation.mutateAsync({
      trackedRankKeywordId,
      rankingUrl: notFound ? null : quickUrl.trim() || null,
      observedRank: notFound ? null : quickRank ? Number(quickRank) : null,
    });
    setQuickUrl("");
    setQuickRank("");
    setNotFound(false);
    onSaved?.();
  }

  async function submitSerp() {
    const results = serpRows
      .filter((r) => r.domain.trim())
      .map((r) => ({
        domain: r.domain.trim(),
        url: r.url.trim() || null,
        rankObserved: r.rankObserved ? Number(r.rankObserved) : null,
        isOwnSite: r.isOwnSite,
      }));
    if (results.length === 0) return;
    await serpMutation.mutateAsync({ trackedRankKeywordId, results });
    setSerpRows([
      { domain: "", rankObserved: "", url: "", isOwnSite: true },
      { domain: "", rankObserved: "", url: "", isOwnSite: false },
    ]);
    onSaved?.();
  }

  const error = quickMutation.error ?? serpMutation.error;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="inline-flex rounded-md border border-border p-0.5">
        {(["quick", "serp"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "rounded px-3 py-1 text-xs font-medium transition-colors",
              mode === m
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m === "quick" ? "Quick check" : "Full SERP"}
          </button>
        ))}
      </div>

      {mode === "quick" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={notFound}
              onChange={(e) => setNotFound(e.target.checked)}
            />
            Not found on the page(s) checked
          </label>
          {!notFound && (
            <>
              <input
                value={quickRank}
                onChange={(e) => setQuickRank(e.target.value)}
                type="number"
                min={1}
                placeholder="Rank #"
                className="h-8 w-20 rounded-md border border-border bg-card px-2 text-sm"
              />
              <input
                value={quickUrl}
                onChange={(e) => setQuickUrl(e.target.value)}
                placeholder="Ranking URL"
                className="h-8 w-64 rounded-md border border-border bg-card px-2 text-sm"
              />
            </>
          )}
          <Button
            size="sm"
            loading={quickMutation.isPending}
            onClick={() => void submitQuick()}
          >
            Save observation
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Every domain seen on the results page - tick "ours" for our own
            site. This feeds the Competitors / Observed Keyword Gap data too.
          </p>
          {serpRows.map((row, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                value={row.rankObserved}
                onChange={(e) => updateRow(i, { rankObserved: e.target.value })}
                type="number"
                min={1}
                placeholder="#"
                className="h-8 w-14 rounded-md border border-border bg-card px-2 text-sm"
              />
              <input
                value={row.domain}
                onChange={(e) => updateRow(i, { domain: e.target.value })}
                placeholder="domain.com"
                className="h-8 w-40 rounded-md border border-border bg-card px-2 text-sm"
              />
              <input
                value={row.url}
                onChange={(e) => updateRow(i, { url: e.target.value })}
                placeholder="URL (optional)"
                className="h-8 flex-1 min-w-[10rem] rounded-md border border-border bg-card px-2 text-sm"
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={row.isOwnSite}
                  onChange={(e) =>
                    updateRow(i, { isOwnSite: e.target.checked })
                  }
                />
                ours
              </label>
              <button
                type="button"
                aria-label="Remove row"
                onClick={() =>
                  setSerpRows((rows) => rows.filter((_, j) => j !== i))
                }
                className="text-muted-foreground hover:text-critical"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setSerpRows((rows) => [
                  ...rows,
                  { domain: "", rankObserved: "", url: "", isOwnSite: false },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add row
            </Button>
            <Button
              size="sm"
              loading={serpMutation.isPending}
              onClick={() => void submitSerp()}
            >
              Save SERP observation
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="text-xs text-critical">
          {error instanceof Error ? error.message : "Could not save."}
        </p>
      )}
    </div>
  );
}
