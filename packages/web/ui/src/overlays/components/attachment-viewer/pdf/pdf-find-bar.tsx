import { CaseSensitiveIcon, ChevronDownIcon, ChevronUpIcon, HighlighterIcon, WholeWordIcon, XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../../../../elements/index.js";

import { useOverlaysCopy } from "../../../copy/overlays-copy.js";
import type { FindCounter } from "../logic/pdf-find.js";
import { ToolbarDivider, ToolbarIconButton, ToolbarTooltips } from "../viewer-toolbar.js";
import type { PdfEventBus } from "./pdf-types.js";
import { usePdfFind } from "./use-pdf-find.js";

/**
 * The Find in Document bar, modelled on pdf.js's own viewer: a search box, a
 * running match count, Previous Match and Next Match, and the Highlight All,
 * Match Case and Match Whole Word toggles. Enter steps to the next match and
 * Shift+Enter to the previous. Closing the bar clears its highlights.
 * Escape is routed here by the PDF view, ahead of the dialog's own Escape.
 */
export function PdfFindBar({ eventBus, onClose }: { eventBus: PdfEventBus; onClose: () => void }) {
  const t = useOverlaysCopy();
  const find = usePdfFind(eventBus);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const notFound = find.tone === "not-found";

  return (
    <ToolbarTooltips>
      <div
        role="search"
        className="absolute top-3 right-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-0.5 overflow-x-auto rounded-full border border-sidebar-border bg-sidebar py-1 pr-1 pl-3 text-sidebar-foreground shadow-lg"
      >
        <input
          ref={inputRef}
          type="search"
          value={find.query}
          placeholder={t("overlays.attachmentViewer.pdf.find.placeholder")}
          aria-label={t("overlays.attachmentViewer.pdf.find")}
          aria-invalid={notFound}
          className={cn(
            "h-7 w-40 min-w-0 rounded-md border border-sidebar-border bg-sidebar-accent px-2 text-xs text-sidebar-accent-foreground outline-none placeholder:text-sidebar-foreground/60 focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/70 sm:w-48 [@media(pointer:coarse)]:h-11",
            notFound && "border-destructive",
          )}
          onChange={(event) => {
            find.setQuery(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (event.shiftKey) find.findPrevious();
            else find.findNext();
          }}
        />
        <span
          aria-live="polite"
          className={cn(
            "min-w-16 shrink-0 px-1 text-center text-xs whitespace-nowrap text-sidebar-foreground/80 tabular-nums",
            notFound && "text-destructive",
          )}
        >
          <FindCounterText counter={find.counter} />
        </span>
        <ToolbarIconButton label={t("overlays.attachmentViewer.pdf.find.previous")} onClick={find.findPrevious}>
          <ChevronUpIcon />
        </ToolbarIconButton>
        <ToolbarIconButton label={t("overlays.attachmentViewer.pdf.find.next")} onClick={find.findNext}>
          <ChevronDownIcon />
        </ToolbarIconButton>
        <ToolbarDivider />
        <ToolbarIconButton
          label={t("overlays.attachmentViewer.pdf.find.highlightAll")}
          pressed={find.highlightAll}
          onClick={find.toggleHighlightAll}
        >
          <HighlighterIcon />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t("overlays.attachmentViewer.pdf.find.matchCase")}
          pressed={find.caseSensitive}
          onClick={find.toggleCaseSensitive}
        >
          <CaseSensitiveIcon />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t("overlays.attachmentViewer.pdf.find.wholeWord")}
          pressed={find.entireWord}
          onClick={find.toggleEntireWord}
        >
          <WholeWordIcon />
        </ToolbarIconButton>
        <ToolbarDivider />
        <ToolbarIconButton label={t("overlays.attachmentViewer.pdf.find.close")} onClick={onClose}>
          <XIcon />
        </ToolbarIconButton>
      </div>
    </ToolbarTooltips>
  );
}

function FindCounterText({ counter }: { counter: FindCounter }) {
  const t = useOverlaysCopy();
  switch (counter.kind) {
    case "blank":
      return null;
    case "no-matches":
      return t("overlays.attachmentViewer.pdf.find.noMatches");
    case "match":
      return t("overlays.attachmentViewer.pdf.find.matchCount", {
        current: counter.current,
        total: counter.total,
      });
  }
}
