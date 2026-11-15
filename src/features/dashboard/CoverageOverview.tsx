import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { HelpTip } from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/dates";
import { useSites } from "@/lib/hooks";
import { useAllCoverage } from "@/features/intelligence/coverage-api";
import { indexedLabel } from "@/features/intelligence/CoverageSection";

/** One line per site: what was discovered, what Google was asked, and the
 * indexed total only when it is genuinely known. Detail lives on the site. */
export function CoverageOverview() {
  const sites = useSites();
  const cov = useAllCoverage();
  const active = (sites.data ?? []).filter((s) => s.is_active);
  if (cov.isLoading || active.length === 0) return null;
  return (
    <Card className="space-y-2 p-4">
      <h2 className="flex items-center gap-1 text-sm font-semibold">
        Search coverage by site
        <HelpTip label="About search coverage">
          Pages found on each site and what Google reports about them. Google is
          asked within a small daily allowance, so a total shows UNKNOWN until
          every page has been looked up.
        </HelpTip>
      </h2>
      <ul className="divide-y divide-border text-sm">
        {active.map((site) => {
          const s = cov.data?.get(site.id);
          return (
            <li
              key={site.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            >
              <Link
                to={`/sites/${site.id}`}
                className="font-medium text-primary hover:underline"
              >
                {site.name}
              </Link>
              {s ? (
                <span className="text-xs text-muted-foreground">
                  {s.discovered} pages · {s.inspected} looked up · indexed{" "}
                  {indexedLabel({
                    complete: s.complete,
                    indexed: s.indexed,
                    inspected: s.inspected,
                    discovered: s.discovered,
                  })}
                  {s.technical_errors > 0
                    ? ` · ${s.technical_errors} technical errors`
                    : ""}
                  {" · "}
                  {relativeTime(s.captured_at)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Not checked yet
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
