import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useSites } from "@/lib/hooks";
import { Card } from "@/components/ui/card";
import { useOpportunities } from "@/features/intelligence/intel-api";
import { topActions } from "@/lib/top-actions";

/** The three things most worth doing now, taken from the validated Fix queue.
 * Plain English only; the Fix queue holds the evidence and the Fix button. */
export function TopActions() {
  const opps = useOpportunities();
  const sites = useSites();
  if (opps.isLoading || !opps.data) return null;
  const actions = topActions(opps.data);
  const siteName = (id: string) =>
    sites.data?.find((s) => s.id === id)?.name ?? "Your site";
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Your top 3 actions</h2>
        <p className="text-xs text-muted-foreground">
          Checked against the real pages and your own Google data. Nothing is
          changed on your websites without your approval.
        </p>
      </div>
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing needs fixing right now.
        </p>
      ) : (
        <ol className="space-y-2">
          {actions.map((o, i) => (
            <li key={o.id} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="font-medium">{o.title}</p>
                <p className="text-xs text-muted-foreground">
                  {siteName(o.site_id)} · {o.problem}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <Link
        to="/opportunities"
        className="inline-flex items-center gap-1 text-xs font-medium text-primary"
      >
        Open the Fix queue <ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
    </Card>
  );
}
