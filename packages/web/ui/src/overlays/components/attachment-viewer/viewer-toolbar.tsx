import * as React from "react";

import { Button, cn } from "../../../elements/index.js";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip.js";

/** Lets the buttons inside share one tooltip delay; every group of toolbar buttons sits in one. */
export function ToolbarTooltips({ children }: { children: React.ReactNode }) {
  return <TooltipProvider delayDuration={300}>{children}</TooltipProvider>;
}

/**
 * The floating dark pill of controls at the bottom of the viewer's stage,
 * shared by PDFs and images. The sidebar tokens are light-on-dark
 * chrome in both themes, so the pill reads the same on a light or dark stage.
 */
export function ViewerToolbar({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <ToolbarTooltips>
      <div
        role="toolbar"
        aria-label={label}
        className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-full border border-sidebar-border bg-sidebar px-2 py-1 text-sidebar-foreground shadow-lg"
      >
        {children}
      </div>
    </ToolbarTooltips>
  );
}

/** An icon-only toolbar button; its label is both its accessible name and its tooltip. */
export function ToolbarIconButton({
  label,
  onClick,
  disabled = false,
  pressed,
  tone = "default",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Set for on/off controls such as the thumbnail and find toggles. */
  pressed?: boolean;
  tone?: "default" | "error";
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "shrink-0 rounded-full bg-transparent text-sidebar-foreground/80 shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring/70 disabled:opacity-40 aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground [@media(pointer:coarse)]:size-11",
            tone === "error" && "text-destructive hover:text-destructive",
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function ToolbarDivider() {
  return (
    <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-sidebar-border" />
  );
}

/** A short status readout such as the zoom percentage. */
export function ToolbarReadout({
  children,
  live = false,
}: {
  children: React.ReactNode;
  /** Announce changes, for readouts that update while nothing is pressed. */
  live?: boolean;
}) {
  return (
    <span
      aria-live={live ? "polite" : undefined}
      className="min-w-12 shrink-0 px-1 text-center text-xs text-sidebar-foreground/80 tabular-nums"
    >
      {children}
    </span>
  );
}
