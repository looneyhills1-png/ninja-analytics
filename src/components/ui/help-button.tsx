import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, type HelpEffect } from "@/components/ui/tooltip";

export interface HelpButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title"
> {
  /** Plain-English explanation of what pressing this does. */
  help: string;
  effect?: HelpEffect;
  disabledReason?: string;
  /** Fill the parent's width (cards, menu rows, sidebar entries). */
  block?: boolean;
}

/** A plain <button> (own styling, no Button chrome) that explains itself with
 * the shared Tooltip: hover, keyboard focus, touch press-and-hold. */
export const HelpButton = forwardRef<HTMLButtonElement, HelpButtonProps>(
  (
    { help, effect, disabledReason, block, className, disabled, ...props },
    ref,
  ) => {
    const fill =
      block || (typeof className === "string" && /\bw-full\b/.test(className));
    return (
      <Tooltip
        content={help}
        effect={effect}
        disabledReason={disabled ? disabledReason : undefined}
        className={fill ? "flex h-full w-full" : undefined}
      >
        <button
          ref={ref}
          disabled={disabled}
          className={cn(fill && "w-full", className)}
          {...props}
        />
      </Tooltip>
    );
  },
);
HelpButton.displayName = "HelpButton";
