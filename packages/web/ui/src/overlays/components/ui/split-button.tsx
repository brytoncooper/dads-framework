"use client";

import type { VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { Button, type buttonVariants, cn } from "../../../elements/index.js";

import { useOverlaysCopy } from "../../copy/overlays-copy.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;

/** Text-bearing Button sizes; the caret takes the matching square icon size. */
type SplitButtonSize = "default" | "xs" | "sm" | "lg";

const CARET_SIZE = {
  default: "icon",
  xs: "icon-xs",
  sm: "icon-sm",
  lg: "icon-lg",
} as const satisfies Record<SplitButtonSize, string>;

/** Filled variants have no border of their own, so the seam needs a divider. */
const FILLED_VARIANTS: readonly ButtonVariant[] = [
  "default",
  "destructive",
  "secondary",
];

export type SplitButtonItem = {
  /** Stable React key for the row. */
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** Id of an element that explains why the row is disabled. */
  readonly describedBy?: string;
};

/**
 * A primary action with an attached caret that opens a menu of related
 * actions. Variants and sizes are Button's own, so it sits among ordinary
 * buttons without a bespoke look.
 */
export function SplitButton({
  children,
  onClick,
  items,
  variant = "outline",
  size = "default",
  disabled = false,
  menuLabel,
  className,
}: {
  /** Content of the primary button. */
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly items: readonly SplitButtonItem[];
  readonly variant?: ButtonVariant;
  readonly size?: SplitButtonSize;
  /** Disables the primary button and the caret together. */
  readonly disabled?: boolean;
  /** Accessible name of the caret; defaults to "More actions". */
  readonly menuLabel?: string;
  readonly className?: string;
}) {
  const t = useOverlaysCopy();
  const filled = FILLED_VARIANTS.includes(variant);
  return (
    <div
      data-slot="split-button"
      className={cn("inline-flex items-stretch", className)}
    >
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        onClick={onClick}
        className="rounded-r-none"
      >
        {children}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size={CARET_SIZE[size]}
            disabled={disabled}
            aria-label={menuLabel ?? t("overlays.splitButton.moreActions")}
            className={cn(
              "rounded-l-none",
              filled ? "border-l border-l-background/40" : "-ml-px",
            )}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              variant={item.destructive ? "destructive" : "default"}
              disabled={item.disabled}
              aria-describedby={item.describedBy}
              onSelect={item.onSelect}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
