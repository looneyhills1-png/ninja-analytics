import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/** What pressing a control does. Shown first so it is always clear whether an
 * action only reads, saves inside Ninja Analytics, or changes a website. */
export type HelpEffect = "read" | "data" | "website";

export const EFFECT_NOTE: Record<HelpEffect, string> = {
  read: "Read-only: changes nothing.",
  data: "Saves inside Ninja Analytics only. Your websites are not touched.",
  website:
    "Can change your live website. It only runs after you have approved it.",
};

export interface TooltipProps {
  /** Plain-English explanation of what the control does. */
  content: ReactNode;
  effect?: HelpEffect;
  /** When set, the control is unavailable and this says why. */
  disabledReason?: string;
  children: ReactNode;
  className?: string;
}

const LONG_PRESS_MS = 450;

/**
 * The one tooltip used everywhere. Works with a mouse (hover), the keyboard
 * (focus, Escape to dismiss) and touch screens (press and hold, tap elsewhere
 * to dismiss). The text is wired to the control with aria-describedby so
 * screen readers announce it. Disabled controls stay reachable by keyboard so
 * the reason they are unavailable can be read.
 */
export function Tooltip({
  content,
  effect,
  disabledReason,
  children,
  className,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const root = useRef<HTMLSpanElement>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  // Keep the text on screen: flip to the right edge when it would overflow.
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const left = root.current.getBoundingClientRect().left;
    setAlignRight(left + 272 > window.innerWidth);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, close]);

  const disabled = Boolean(disabledReason);
  const text = disabled ? `Unavailable: ${disabledReason}` : content;
  const child =
    isValidElement(children) && !disabled
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          "aria-describedby": id,
        })
      : children;

  return (
    <span
      ref={root}
      className={cn("relative inline-flex", className)}
      // A disabled control cannot take focus, so the wrapper does instead.
      tabIndex={disabled ? 0 : undefined}
      aria-describedby={disabled ? id : undefined}
      aria-disabled={disabled || undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        clearTimer();
        setOpen(false);
      }}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        longPressed.current = false;
        clearTimer();
        timer.current = window.setTimeout(() => {
          longPressed.current = true;
          setOpen(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      // After a press-and-hold that revealed the help, do not also fire the
      // control: the owner only asked what it does.
      onClickCapture={(e) => {
        if (longPressed.current) {
          e.preventDefault();
          e.stopPropagation();
          longPressed.current = false;
        }
      }}
      onContextMenu={(e) => {
        if (longPressed.current) e.preventDefault();
      }}
    >
      {child}
      <span
        id={id}
        role="tooltip"
        data-open={open}
        className={cn(
          "pointer-events-none absolute top-full z-50 mt-1 w-max max-w-[16rem] rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs font-normal leading-snug text-foreground shadow-lg",
          alignRight ? "right-0" : "left-0",
          // display:none when closed: it cannot widen the page, and
          // aria-describedby still resolves to it for screen readers.
          !open && "hidden",
        )}
      >
        <span className="block">{text}</span>
        {effect && !disabled && (
          <span
            className={cn(
              "mt-1 block font-medium",
              effect === "website" ? "text-warning" : "text-muted-foreground",
            )}
          >
            {EFFECT_NOTE[effect]}
          </span>
        )}
      </span>
    </span>
  );
}

/** A small "?" for charts, status badges and settings that have no button of
 * their own. Focusable, so keyboard and touch users can read it too. */
export function HelpTip({
  children,
  label = "More information",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        ?
      </button>
    </Tooltip>
  );
}
