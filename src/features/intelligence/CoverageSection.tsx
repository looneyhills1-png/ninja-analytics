import { useState } from "react";
import { relativeTime } from "@/lib/dates";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useCheckCoverage,
  useCoverageSnapshots,
  useUrlDetails,
  type CoverageDetail,
  type CoverageSnapshot,
} from "./coverage-api";

/** The wording rule for site-wide indexed totals: only a complete inspection
 * can give a total. A sample is never extrapolated, so it reads UNKNOWN. */
export function indexedLabel(s: {
  complete: boolean;
  indexed: number;
  inspected: number;
  discovered: number;
}): string {
  return s.complete
    ? `${s.indexed} of ${s.inspected}`
    : `UNKNOWN (${s.indexed} of ${s.inspected} inspected so far; ${s.discovered} pages discovered)`;
}

const CATEGORY_TONE: Record<string, string> = {
  healthy: "text-success",
  alias: "text-muted-foreground",
  redirect: "text-muted-foreground",
  not_found: "text-critical",
  noindex: "text-muted-foreground",
  blocked: "text-critical",
  content: "text-warning",
  waiting: "text-muted-foreground",
  undiscovered: "text-warning",
  unknown: "text-muted-foreground",
};

export function CoverageSection({ siteId }: { siteId: string }) {
  const snaps = useCoverageSnapshots(siteId);
  const check = useCheckCoverage(siteId);
  const [open, setOpen] = useState(false);
  const details = useUrlDetails(siteId, open);
  const [filter, setFilter] = useState<"problems" | "all">("problems");

  if (snaps.isLoading) return <Skeleton className="h-24" />;
  const s = snaps.data?.latest ?? null;
  const detail = (s?.detail ?? {}) as CoverageDetail;
  const maps = snaps.data?.sitemaps ?? [];
  const prev = snaps.data?.previous ?? null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
          Search coverage
          <HelpTip label="About search coverage">
            Every page found from your sitemaps, links and Search Console, what
            Google says about each one, and what your live site actually does.
            Google&apos;s page-by-page lookup is a limited daily allowance, so
            big sites fill in over several days. A total is only shown once
            every page has been looked up.
          </HelpTip>
        </h3>
        <Button
          size="sm"
          variant="secondary"
          loading={check.isPending}
          onClick={() => check.mutate()}
          help="Looks for new pages in your sitemaps and links, checks the oldest ones on your live site, and asks Google about them within a small daily allowance. It only reads; nothing on your website is changed."
          effect="data"
        >
          {check.isPending ? "Checking…" : "Check coverage now"}
        </Button>
      </div>

      {check.isError && (
        <p role="alert" className="text-sm text-critical">
          {(check.error as Error).message}
        </p>
      )}

      {!s ? (
        <p className="text-sm text-muted-foreground">
          Not checked yet. Press Check coverage now.
        </p>
      ) : (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Pages discovered" value={s.discovered} />
            <Stat
              label="Checked on your live site"
              value={`${s.live_checked} of ${s.discovered}`}
            />
            <Stat
              label="Looked up in Google"
              value={`${s.inspected} of ${s.discovered}`}
            />
            <div>
              <dt className="text-xs text-muted-foreground">Google-indexed</dt>
              <dd
                className={cn(
                  "font-medium",
                  !s.complete && "text-muted-foreground",
                )}
              >
                {indexedLabel({
                  complete: s.complete,
                  indexed: s.indexed,
                  inspected: s.inspected,
                  discovered: s.discovered,
                })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Technical errors
              </dt>
              <dd
                className={cn(
                  "font-medium",
                  s.technical_errors > 0 ? "text-critical" : "text-success",
                )}
              >
                {s.technical_errors}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Last collected {relativeTime(s.captured_at)}
            {prev ? `. Before that: ${snapshotLine(prev)}.` : "."}
          </p>

          {(detail.excludedByReason ?? []).length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Not indexed, with Google&apos;s reason (among pages looked up)
              </p>
              <ul className="text-sm">
                {(detail.excludedByReason ?? []).map((r) => (
                  <li key={r.reason}>
                    {r.count} · {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.unknown_state > 0 && (
            <p className="text-xs text-muted-foreground">
              {s.unknown_state} looked-up pages are &quot;unknown to
              Google&quot; (not yet discovered). Open the list to see which.
            </p>
          )}
          {(detail.technicalErrors ?? []).length > 0 && (
            <ul className="text-sm text-critical">
              {(detail.technicalErrors ?? []).slice(0, 5).map((e) => (
                <li key={e.url}>
                  {e.url} — {e.problem}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {maps.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Sitemaps Google knows:{" "}
          {maps
            .map(
              (m) =>
                `${m.path.replace(/^https?:\/\/[^/]+/, "")} (downloaded ${
                  m.last_downloaded ? relativeTime(m.last_downloaded) : "never"
                }${m.errors ? `, ${m.errors} errors` : ""}${m.warnings ? `, ${m.warnings} warnings` : ""})`,
            )
            .join("; ")}
        </p>
      )}

      {s && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            help="Shows or hides every discovered page with what Google says, what your live site does, and whether it should be indexed. Display only."
            effect="read"
          >
            {open ? "Hide page list" : "Show page list"}
          </Button>
          {open && (
            <div className="space-y-2">
              <div className="flex gap-2 text-xs">
                {(["problems", "all"] as const).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant={filter === f ? "primary" : "secondary"}
                    onClick={() => setFilter(f)}
                    help={
                      f === "problems"
                        ? "Shows only pages that need attention. Display only."
                        : "Shows every discovered page. Display only."
                    }
                    effect="read"
                  >
                    {f === "problems" ? "Needs attention" : "All pages"}
                  </Button>
                ))}
              </div>
              {details.isLoading ? (
                <Skeleton className="h-24" />
              ) : (
                <ul className="max-h-96 space-y-2 overflow-y-auto">
                  {(details.data ?? [])
                    .filter(
                      (d) =>
                        filter === "all" ||
                        !["healthy", "alias"].includes(d.diagnosis.category),
                    )
                    .slice(0, 200)
                    .map((d) => (
                      <li
                        key={d.diagnosis.url}
                        className="rounded-md border border-border p-2 text-xs"
                      >
                        <p className="break-all font-medium">
                          {d.diagnosis.url}
                        </p>
                        <p
                          className={cn(
                            "font-medium",
                            CATEGORY_TONE[d.diagnosis.category],
                          )}
                        >
                          Should it be indexed? {d.diagnosis.shouldBeIndexed}
                          {" · "}
                          {d.diagnosis.reason}
                        </p>
                        <p className="text-muted-foreground">
                          {d.diagnosis.evidence.join(" · ")}
                        </p>
                        <p>{d.diagnosis.action}</p>
                        {d.inspectionLink && (
                          <a
                            href={d.inspectionLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            Open in Search Console
                          </a>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function snapshotLine(p: CoverageSnapshot): string {
  return `${p.discovered} discovered, ${p.inspected} looked up, ${p.indexed} indexed (${relativeTime(p.captured_at)})`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
