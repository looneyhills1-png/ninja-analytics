import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shows a generated fix prompt for one keyword opportunity, readable before
 * copying - never auto-copies, auto-edits, or auto-publishes anything. Same
 * backdrop/dialog pattern as SiteFormDialog for consistency.
 */
export function FixPromptModal({
  title,
  prompt,
  onClose,
}: {
  title: string;
  prompt: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const pressStartedOnBackdrop = useRef(false);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    pressStartedOnBackdrop.current = e.target === e.currentTarget;
  };
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && pressStartedOnBackdrop.current) {
      onClose();
    }
    pressStartedOnBackdrop.current = false;
  };

  async function handleCopy() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className="mt-10 w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Generated fix prompt"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Fix prompt</h2>
            <p className="text-xs text-muted-foreground">{title}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Review before copying. This only generates text - nothing is edited,
          committed, or deployed from here.
        </p>

        <textarea
          readOnly
          value={prompt}
          rows={18}
          className="mt-3 w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
          onFocus={(e) => e.currentTarget.select()}
        />

        {copyError && (
          <p className="mt-2 text-xs text-critical">
            Couldn't copy automatically - select the text above and copy it
            manually.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="button" onClick={() => void handleCopy()}>
            {copied ? "Copied!" : "Copy prompt"}
          </Button>
        </div>
      </div>
    </div>
  );
}
