import { useOutletContext } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import {
  DomainPicker,
  useDomainOptions,
} from "@/features/competitors/domain-picker";
import type { CompetitorsOutletContext } from "@/features/competitors/CompetitorsLayout";
import { Card } from "@/components/ui/card";

/**
 * Links / Referring Pages - honestly unavailable within the zero-cost
 * constraint, not faked. Common Crawl does publish a host-level web graph
 * (commoncrawl.org/web-graph), but it's distributed as large Parquet files
 * on S3 that need Athena/Spark-scale query infrastructure to search - not a
 * simple free API call an Edge Function can make the way the CDX index
 * (used for Historical Pages) can. Per CLAUDE.md: "if exact data is
 * unavailable for free, show a transparent proxy instead of inventing it" -
 * there is no honest proxy for this yet, so this says so instead of
 * shipping fabricated backlink data.
 */
export function CompetitorsLinksPage() {
  const { siteId } = useOutletContext<CompetitorsOutletContext>();
  const domains = useDomainOptions(siteId);
  const [domain, setDomain] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <DomainPicker domains={domains} value={domain} onChange={setDomain} />
      <Card className="border-warning/30 bg-warning/5">
        <div className="flex items-start gap-3 p-4">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium">
              Not available yet within the zero-cost constraint
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Common Crawl does publish a free host-level web graph, but it's
              distributed as large Parquet files on S3 that need
              Athena/Spark-scale query infrastructure to search - not a simple
              API call this app can make for free the way Historical Pages uses
              Common Crawl's CDX index. Rather than show estimated or fabricated
              referring-page/anchor-text data, this tab stays empty until a
              genuinely free, practical method exists.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
