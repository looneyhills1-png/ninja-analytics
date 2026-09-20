import type { OpportunityScoreResult } from "@/lib/opportunity-score";
import { cn } from "@/lib/utils";

function scoreTone(score: number): string {
  if (score >= 65) return "bg-success";
  if (score >= 35) return "bg-warning";
  return "bg-muted-foreground/50";
}

/** The 0-100 Ninja Opportunity Score as a bar, with the full factor
 * breakdown available as a native title tooltip - "the UI must expose the
 * factors behind the score" (CLAUDE.md), without a heavier popover for v1. */
export function ScoreBar({ score }: { score: OpportunityScoreResult }) {
  const title = score.factors
    .map((f) => `${f.label}: ${f.points} pts - ${f.explanation}`)
    .join("\n");
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", scoreTone(score.score))}
          style={{ width: `${score.score}%` }}
        />
      </div>
      <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums">
        {score.score}
      </span>
    </div>
  );
}

/** Full, always-visible factor breakdown - used on drill-down/detail views
 * where a hover tooltip isn't discoverable enough. */
export function ScoreFactorList({ score }: { score: OpportunityScoreResult }) {
  return (
    <ul className="space-y-1.5 text-xs">
      {score.factors.map((f) => (
        <li key={f.key} className="flex items-start justify-between gap-3">
          <div>
            <span className="font-medium">{f.label}</span>
            <p className="text-muted-foreground">{f.explanation}</p>
          </div>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {f.points} pts
          </span>
        </li>
      ))}
    </ul>
  );
}
