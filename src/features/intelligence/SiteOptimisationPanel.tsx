import { useState } from "react";
import { Wand2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { FixPromptModal } from "@/features/keywords/FixPromptModal";
import { buildOpportunityFixPrompt } from "@/features/keywords/generateFixPrompt";
import type { OptimisationChange } from "@/types/database";
import {
  MAX_AUTO,
  useAnalyse,
  useChangeAction,
  useChangeOutcome,
  useOptimiseState,
  useSetMode,
  type OptimiseMode,
} from "./optimise-api";
import { CoverageSection } from "./CoverageSection";

const MODES: Array<{
  mode: OptimiseMode;
  label: string;
  help: string;
}> = [
  {
    mode: "monitor",
    label: "Monitor",
    help: "Read-only. Ninja Analytics analyses your site and recommends changes. It never changes anything.",
  },
  {
    mode: "safe_auto",
    label: "Safe auto-fix",
    help: "After the safeguards pass, applies only allowlisted low-risk changes (currently a click-rate meta-description refresh, NinjaTickets only). Each one is backed up, limited in size and can be rolled back. Everything else still waits for you.",
  },
  {
    mode: "approval_required",
    label: "Approval required",
    help: "Prepares bigger changes (content edits, new pages, redirects, deletions, affiliate changes) for your approval. Nothing is applied automatically.",
  },
];

const RISK_TONE = {
  low: "text-success",
  substantial: "text-warning",
} as const;

function healthTone(score: number | null) {
  if (score == null) return "text-muted-foreground";
  return score >= 80
    ? "text-success"
    : score >= 60
      ? "text-warning"
      : "text-critical";
}

export function SiteOptimisationPanel({
  siteId,
  siteName,
  siteDomain,
  hostingPlatform = "unknown",
  hostingProjectId = null,
  publishing,
}: {
  siteId: string;
  siteName: string;
  siteDomain: string;
  hostingPlatform?: string;
  hostingProjectId?: string | null;
  publishing?: unknown;
}) {
  const state = useOptimiseState(siteId);
  const [progress, setProgress] = useState("");
  const analyse = useAnalyse(siteId, setProgress);
  const setMode = useSetMode(siteId);
  const action = useChangeAction(siteId);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [promptFor, setPromptFor] = useState<OptimisationChange | null>(null);

  if (state.isLoading) return <Skeleton className="h-48" />;
  if (state.isError || !state.data) {
    return (
      <Card className="p-4 text-sm text-critical">
        Optimisation could not be loaded.
      </Card>
    );
  }
  const { mode, run, changes } = state.data;
  const health = (run?.health ?? {}) as {
    score?: number | null;
    scoreSource?: string;
    auditAt?: string | null;
    searchDataThrough?: string | null;
    stale?: string[];
  };
  const open = changes.filter((c) =>
    ["proposed", "needs_approval"].includes(c.status),
  );
  const top3 = open.slice(0, 3);
  const applied = changes.filter((c) =>
    ["applied", "verified", "rolled_back"].includes(c.status),
  );
  const needApproval = open.filter((c) => c.status === "needs_approval");

  function chooseMode(next: OptimiseMode) {
    if (next === mode) return;
    if (next === "safe_auto") {
      setConfirming(true);
      setTyped("");
      return;
    }
    setMode.mutate(next);
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Optimise {siteName}
            <HelpTip label="About optimising this site">
              Analyse & Optimise reads your own Search Console data and site
              audit, ranks what to improve, and (only in Safe auto-fix mode)
              applies allowlisted low-risk fixes with a backup. It never uses
              paid AI and never publishes without the mode you choose.
            </HelpTip>
          </h2>
          <p className="text-xs text-muted-foreground">
            {run
              ? `Last analysed ${relativeTime(run.started_at)}.`
              : "Not analysed yet."}
          </p>
          <HostingLine
            platform={hostingPlatform}
            projectId={hostingProjectId}
            publishing={publishing}
          />
        </div>
        <Button
          onClick={() => analyse.mutate(state.data)}
          loading={analyse.isPending}
          help={
            mode === "safe_auto"
              ? `Reads your data and ranks improvements. Because Safe auto-fix is on, it then applies up to ${MAX_AUTO} eligible low-risk changes that pass every safeguard.`
              : "Reads your data and your site (read-only) and ranks improvements. Saves the plan here. Changes nothing on your website."
          }
          effect={mode === "safe_auto" ? "website" : "data"}
        >
          <Wand2 className="h-4 w-4" aria-hidden />
          {analyse.isPending ? progress || "Working…" : "Analyse & Optimise"}
        </Button>
      </div>

      {analyse.isError && (
        <p role="alert" className="text-sm text-critical">
          {(analyse.error as Error).message}
        </p>
      )}
      {analyse.isSuccess && (
        <p className="text-sm" role="status">
          {analyse.data.reused
            ? "Analysed a moment ago, so the existing plan is shown."
            : "Analysis complete."}
          {analyse.data.applied.length > 0 &&
            ` Applied: ${analyse.data.applied.join("; ")}.`}
          {analyse.data.refused.length > 0 &&
            ` Not applied: ${analyse.data.refused.join("; ")}`}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            SEO health
            <HelpTip label="About SEO health">
              The health score from the last site audit of your own pages. It is
              not a ranking and not a prediction.
            </HelpTip>
          </p>
          <p
            className={cn(
              "text-2xl font-semibold",
              healthTone(health.score ?? null),
            )}
          >
            {health.score ?? "—"}
            {health.score != null && (
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                / 100
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {health.scoreSource ?? "No audit yet"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Data freshness</p>
          <p className="text-sm">
            Search data through {health.searchDataThrough ?? "—"}
          </p>
          <p className="text-sm">
            Audit {health.auditAt ? relativeTime(health.auditAt) : "never run"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Needs attention</p>
          {(health.stale ?? []).length === 0 ? (
            <p className="text-sm text-success">Data is current.</p>
          ) : (
            <ul className="text-sm text-warning">
              {(health.stale ?? []).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
          How changes are handled
          <HelpTip label="About modes">
            Every site starts in Monitor. Safe auto-fix can only be turned on by
            you, and only ever applies the allowlisted change type.
          </HelpTip>
        </p>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Optimisation mode"
        >
          {MODES.map((m) => (
            <Button
              key={m.mode}
              size="sm"
              variant={mode === m.mode ? "primary" : "secondary"}
              aria-pressed={mode === m.mode}
              onClick={() => chooseMode(m.mode)}
              help={m.help}
              effect={m.mode === "safe_auto" ? "website" : undefined}
              disabled={setMode.isPending}
              disabledReason="Saving the change."
            >
              {m.label}
            </Button>
          ))}
        </div>
        {confirming && (
          <div className="mt-3 space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
            <p className="font-medium">Turn on Safe auto-fix for {siteName}?</p>
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              <li>
                Only click-rate meta-description refreshes can be applied, only
                after backup, size limit and validation checks pass.
              </li>
              <li>
                Each change is committed to your site&apos;s repository and can
                be rolled back from here.
              </li>
              <li>At most {MAX_AUTO} changes per analysis, 3 per day.</li>
              <li>Everything else still waits for your approval.</li>
            </ul>
            <label className="block text-xs">
              Type ENABLE to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="mt-1 h-8 w-40 rounded-md border border-border bg-card px-2 text-sm"
                aria-label="Type ENABLE to confirm"
              />
            </label>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={typed !== "ENABLE" || setMode.isPending}
                disabledReason={
                  typed !== "ENABLE"
                    ? "Type ENABLE in the box first."
                    : "Saving."
                }
                help="Turns Safe auto-fix on for this site. You can switch back to Monitor at any time."
                effect="website"
                onClick={() => {
                  setMode.mutate("safe_auto");
                  setConfirming(false);
                }}
              >
                Turn on
              </Button>
              <Button
                size="sm"
                variant="ghost"
                help="Keeps the current mode. Nothing changes."
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {setMode.isError && (
          <p role="alert" className="mt-2 text-sm text-critical">
            The mode could not be changed.
          </p>
        )}
      </div>

      <CoverageSection siteId={siteId} />

      <section>
        <h3 className="text-xs font-semibold text-muted-foreground">
          Top 3 recommended improvements
        </h3>
        {top3.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {run
              ? "Nothing to improve right now."
              : "Press Analyse & Optimise to find improvements."}
          </p>
        ) : (
          <ol className="mt-1 space-y-2">
            {top3.map((c) => (
              <ChangeRow
                key={c.id}
                c={c}
                onFix={() => setPromptFor(c)}
                onDismiss={() =>
                  action.mutate({ changeId: c.id, action: "dismiss" })
                }
              />
            ))}
          </ol>
        )}
      </section>

      {needApproval.length > 3 && (
        <p className="text-xs text-muted-foreground">
          {needApproval.length - 3} more waiting for your approval. See the Fix
          queue for the full list.
        </p>
      )}

      <section>
        <h3 className="text-xs font-semibold text-muted-foreground">
          Changes applied and verified
        </h3>
        {applied.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No change has been applied automatically.
          </p>
        ) : (
          <ul className="mt-1 space-y-2">
            {applied.map((c) => (
              <AppliedRow
                key={c.id}
                c={c}
                onRollback={() =>
                  action.mutate({ changeId: c.id, action: "rollback" })
                }
              />
            ))}
          </ul>
        )}
      </section>

      {action.isError && (
        <p role="alert" className="text-sm text-critical">
          {(action.error as Error).message}
        </p>
      )}

      {promptFor && (
        <FixPromptModal
          title={`${siteName} - ${promptFor.title}`}
          prompt={buildOpportunityFixPrompt({
            siteName,
            siteDomain,
            status: "validated",
            classification: null,
            changeType: promptFor.change_class,
            targetUrl: promptFor.url,
            title: promptFor.title,
            problem: promptFor.problem,
            recommendedChange: promptFor.recommendation,
            proposal: promptFor.recommendation,
            expectedImpact: "An estimate only; measured after the change.",
            evidence: promptFor.evidence,
            baselineText: null,
            requiresPublishApproval: true,
            ownerNote: null,
          })}
          onClose={() => setPromptFor(null)}
        />
      )}
    </Card>
  );
}

function ChangeRow({
  c,
  onFix,
  onDismiss,
}: {
  c: OptimisationChange;
  onFix: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{c.title}</p>
          <p className="text-xs text-muted-foreground">
            {c.url ?? "Several pages or site-wide"} · priority {c.priority} ·{" "}
            <span className={RISK_TONE[c.risk]}>
              {c.risk === "low" ? "low risk" : "needs your approval"}
            </span>
            {c.auto_eligible && " · eligible for safe auto-fix"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={onFix}
            help="Opens a ready-to-copy prompt for this improvement. It only writes text; nothing is edited or published."
            effect="read"
          >
            Fix
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDismiss}
            help="Removes this suggestion from the plan. It is kept in the history. Your website is not touched."
            effect="data"
          >
            Dismiss
          </Button>
        </div>
      </div>
      <p className="mt-1">{c.problem}</p>
      <p className="text-muted-foreground">{c.recommendation}</p>
      <ProposedChange c={c} />
      {c.deployment === "blocked" && (
        <p className="mt-1 text-xs font-medium text-warning">
          {c.deployment_note ??
            "Deployment BLOCKED: no authorised publishing interface."}
        </p>
      )}
    </li>
  );
}

function AppliedRow({
  c,
  onRollback,
}: {
  c: OptimisationChange;
  onRollback: () => void;
}) {
  const live = c.status === "applied" || c.status === "verified";
  const outcome = useChangeOutcome(c, live);
  const o = outcome.data;
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{c.title}</p>
          <p className="text-xs text-muted-foreground">
            {c.status === "rolled_back" ? "Rolled back" : "Applied"}{" "}
            {relativeTime(c.updated_at)}
            {c.commit_sha ? ` · commit ${c.commit_sha.slice(0, 7)}` : ""}
          </p>
        </div>
        {live && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRollback}
            help="Restores the exact file as it was before this change. It refuses if the file has been edited since, so it can never overwrite newer work."
            effect="website"
          >
            Roll back
          </Button>
        )}
      </div>
      {c.note && <p className="text-xs text-muted-foreground">{c.note}</p>}
      {live && o && (
        <p className="mt-1 text-xs">
          <span className="font-medium">Before / after:</span> {o.text}
        </p>
      )}
    </li>
  );
}

const PLATFORM_NAME: Record<string, string> = {
  chatgpt_sites: "ChatGPT Sites",
  github_repo: "GitHub repository",
  wordpress: "WordPress",
  other: "Other platform",
  unknown: "Not recorded",
};

function HostingLine({
  platform,
  projectId,
  publishing,
}: {
  platform: string;
  projectId: string | null;
  publishing?: unknown;
}) {
  const p = (publishing ?? {}) as {
    ninjaCanPublish?: boolean;
    summary?: string;
  };
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      Hosted on {PLATFORM_NAME[platform] ?? platform}
      {projectId ? ` (${projectId})` : ""}
      {" · "}
      {p.ninjaCanPublish
        ? "Ninja Analytics can publish here"
        : "Ninja Analytics cannot publish here"}
      <HelpTip label="About publishing for this site">
        {p.summary ??
          "No publishing capability has been recorded for this site, so changes are recommendations only."}
      </HelpTip>
    </p>
  );
}

interface PatchShape {
  summary?: string;
  totalLinks?: number;
  pages?: Array<{ page: string; links: Array<{ from: string; to: string }> }>;
}

/** The exact change, kept so it can be applied elsewhere when this site cannot
 * be published to from here. Copying it only writes to the clipboard. */
function ProposedChange({ c }: { c: OptimisationChange }) {
  const [copied, setCopied] = useState(false);
  const patch = c.proposed_change as PatchShape | null;
  if (!patch || typeof patch !== "object") return null;
  const pages = patch.pages ?? [];
  return (
    <details className="mt-2 rounded-md border border-border p-2 text-xs">
      <summary className="cursor-pointer font-medium">
        Exact proposed change
        {patch.totalLinks
          ? ` (${patch.totalLinks} links on ${pages.length} pages)`
          : ""}
      </summary>
      <p className="mt-1 text-muted-foreground">{patch.summary}</p>
      <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
        {pages.map((p) => (
          <li key={p.page}>
            <span className="font-medium">{p.page}</span>
            <ul className="pl-3 text-muted-foreground">
              {p.links.map((l) => (
                <li key={l.from}>
                  {l.from} → {l.to}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        help="Copies the exact change as JSON to your clipboard so it can be applied in the site's own project. Nothing is sent or changed."
        effect="read"
        onClick={() => {
          void navigator.clipboard
            .writeText(JSON.stringify(patch, null, 2))
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? "Copied!" : "Copy exact change"}
      </Button>
    </details>
  );
}
