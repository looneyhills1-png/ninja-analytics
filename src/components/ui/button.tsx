import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, type HelpEffect } from "@/components/ui/tooltip";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary",
  secondary:
    "border border-border bg-card text-foreground hover:bg-muted focus-visible:ring-primary",
  ghost: "text-foreground hover:bg-muted focus-visible:ring-primary",
  danger:
    "bg-critical text-white hover:bg-critical/90 focus-visible:ring-critical",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Plain-English explanation of what pressing this does. A legacy `title`
   * is shown the same way, so every labelled button explains itself on
   * hover, keyboard focus and touch press-and-hold. */
  help?: string;
  /** Whether the action only reads, saves in Ninja Analytics, or can change a website. */
  effect?: HelpEffect;
  /** Why the button is currently unavailable (shown when disabled). */
  disabledReason?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading,
      disabled,
      children,
      help,
      effect,
      disabledReason,
      title,
      ...props
    },
    ref,
  ) => {
    const button = (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...props}
      >
        {loading && <Spinner />}
        {children}
      </button>
    );
    const text = help ?? title;
    if (!text && !disabledReason) return button;
    return (
      <Tooltip
        content={text ?? ""}
        effect={effect}
        disabledReason={disabled || loading ? disabledReason : undefined}
      >
        {button}
      </Tooltip>
    );
  },
);
Button.displayName = "Button";
