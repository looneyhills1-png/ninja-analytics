import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { InsightsResult } from "@/lib/insights";
import { buildBriefingEvidence } from "@/lib/briefing-evidence";
import {
  explainLocally,
  getLocalAiStatus,
  LOCAL_AI_ERRORS,
  type LocalAiStatus,
} from "@/lib/local-ai-client";

/**
 * Plain-English briefing written by the AI model on this PC (Ollama). It only
 * explains numbers the dashboard has already computed. When the local model is
 * not available the card says so instead of pretending to work. It never uses
 * a paid or external AI service.
 */
export function BriefingCard({
  data,
  topActionTitles = [],
}: {
  data?: InsightsResult;
  topActionTitles?: string[];
}) {
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getLocalAiStatus().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);

  async function write() {
    if (!data) return;
    setBusy(true);
    setError(null);
    const r = await explainLocally({
      kind: "portfolio",
      evidence: buildBriefingEvidence(data, topActionTitles),
    });
    setBusy(false);
    if (r.ok && r.text) {
      setText(r.text);
      setMeta(
        `${r.model ?? "the local model"}${r.cached ? " (reused from earlier today)" : ""}`,
      );
    } else {
      setError(
        (r.error && LOCAL_AI_ERRORS[r.error]) ??
          r.message ??
          "The briefing could not be written.",
      );
    }
  }

  const unavailable = status !== null && !status.available;
  const reason = unavailable
    ? (status?.reason ?? "The local AI model is not available.")
    : !data
      ? "There is no data to summarise yet."
      : undefined;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            <span className="text-sm font-semibold">AI briefing</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Runs on this PC
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void write()}
            disabled={busy || status === null || Boolean(reason)}
            disabledReason={reason ?? "Checking the local AI model."}
            help="Asks the AI model on this PC to explain your numbers in plain English. It runs locally, nothing is sent to the internet, and nothing on your websites is changed. Limited to a few runs a day."
            effect="read"
          >
            {busy ? <Spinner /> : null}
            {busy ? "Writing…" : text ? "Write again" : "Write my briefing"}
          </Button>
        </div>
        {text && (
          <div className="space-y-1">
            <p className="whitespace-pre-line text-sm">{text}</p>
            <p className="text-xs text-muted-foreground">
              Written by {meta}. It explains the numbers shown here; it is not
              new data.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        {unavailable && !text && (
          <p className="text-xs text-muted-foreground">
            Unavailable: {status?.reason} The rest of the dashboard works
            normally.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
