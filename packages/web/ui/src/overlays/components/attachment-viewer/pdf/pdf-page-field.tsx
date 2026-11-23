import * as React from "react";

import { useOverlaysCopy } from "../../../copy/overlays-copy.js";
import { parsePageInput } from "../logic/pdf-page-input.js";

export type PdfPageFieldHandle = {
  /** True while the reader is typing a page number that is not yet committed. */
  readonly isEditing: () => boolean;
  /** Drops the typed page number, shows the live page again, and leaves the box. */
  readonly abandon: () => void;
};

/**
 * The editable "page N of M" box. While the reader types, the box holds their
 * draft; Enter or leaving the box commits it. When the page changes from
 * elsewhere (scrolling, the arrows, a thumbnail) the box follows, but only
 * while nobody is typing in it. Escape abandons the draft; the PDF view
 * routes that key here through the handle, because the dialog would
 * otherwise take Escape as "close".
 */
export function PdfPageField({
  ref,
  pageNumber,
  pageCount,
  onCommit,
}: {
  ref: React.Ref<PdfPageFieldHandle>;
  pageNumber: number;
  pageCount: number;
  onCommit: (page: number) => void;
}) {
  const t = useOverlaysCopy();
  // null while the reader is not typing, so the box follows the visible page.
  const [draft, setDraft] = React.useState<string | null>(null);
  const draftRef = React.useRef<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Set by `abandon`, so the blur it causes does not commit the dropped draft.
  const skipCommitRef = React.useRef(false);

  function changeDraft(next: string | null) {
    draftRef.current = next;
    setDraft(next);
  }

  function commit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    if (draftRef.current !== null) {
      const page = parsePageInput(draftRef.current, pageCount);
      if (page !== null) onCommit(page);
    }
    changeDraft(null);
  }

  React.useImperativeHandle(
    ref,
    () => ({
      isEditing: () => draftRef.current !== null,
      abandon: () => {
        skipCommitRef.current = true;
        changeDraft(null);
        inputRef.current?.blur();
      },
    }),
    [],
  );

  return (
    <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-sidebar-foreground/80 tabular-nums">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={draft ?? String(pageNumber)}
        aria-label={t("overlays.attachmentViewer.pdf.pageNumber")}
        className="h-7 w-10 rounded-md border border-sidebar-border bg-sidebar-accent text-center text-xs text-sidebar-accent-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/70 [@media(pointer:coarse)]:h-11"
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onChange={(event) => {
          changeDraft(event.currentTarget.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }}
      />
      <span className="whitespace-nowrap">{t("overlays.attachmentViewer.pdf.pageCount", { count: pageCount })}</span>
    </span>
  );
}
