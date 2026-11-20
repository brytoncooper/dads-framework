import * as React from "react";

import { Input } from "../../../forms/index.js";

import { useDebouncedCallback } from "../../hooks/use-debounced-callback.js";

/** Quiet period after the last keystroke before the term is written. */
export const DATA_TABLE_SEARCH_SETTLE_MS = 200;

/**
 * A toolbar search box that keeps what the reader typed.
 *
 * The term lives in the URL, and a route that loads its list holds a new URL
 * back until that list arrives. A box that showed the URL's value directly
 * showed the old term for that whole wait, so the next keystroke was applied
 * to the old term and everything typed in between was lost. This box owns the
 * text while the reader types and writes it once typing settles, so a word is
 * one request rather than one per key.
 *
 * The URL stays the truth. A value arriving from outside — Reset, Back —
 * replaces the text. A value this box wrote does not, even when it arrives
 * late and the reader has typed on since.
 */
export function DataTableSearchInput({
  value,
  onCommit,
  ...inputProps
}: Omit<
  React.ComponentProps<typeof Input>,
  "value" | "defaultValue" | "onChange"
> & {
  readonly value: string;
  readonly onCommit: (term: string) => void;
}) {
  const [text, setText] = React.useState(value);
  // What a settled timer commits: the box as it is then, so a timer set
  // before the reader emptied the box cannot write the old term back.
  const latestText = React.useRef(value);
  // Terms written and not yet seen back as `value`, oldest first. The router
  // never commits a navigation a newer one overtook, so when one of these
  // arrives, the older ones never will.
  const unechoedWrites = React.useRef<string[]>([]);

  React.useEffect(() => {
    // The newest copy: a term written twice lands as its later write.
    const echo = unechoedWrites.current.lastIndexOf(value);
    if (echo !== -1) {
      unechoedWrites.current = unechoedWrites.current.slice(echo + 1);
      return;
    }
    unechoedWrites.current = [];
    latestText.current = value;
    setText(value);
  }, [value]);

  /**
   * Write `term` unless it is already on its way. `resend` writes it again
   * anyway, for Enter: a write another navigation overtook never arrives, so
   * the box would otherwise show a term the list is not using.
   */
  function commit(term: string, resend = false): void {
    const pending = unechoedWrites.current.at(-1);
    if (term === value) {
      // Back to the URL's own term: nothing to wait for, and any pending
      // write has to be overtaken so it cannot land after this.
      unechoedWrites.current = [];
      if (pending !== undefined) onCommit(term);
      return;
    }
    if (term === pending && !resend) return;
    if (term !== pending) {
      unechoedWrites.current = [...unechoedWrites.current, term];
    }
    onCommit(term);
  }
  const scheduleCommit = useDebouncedCallback(() => {
    commit(latestText.current);
  }, DATA_TABLE_SEARCH_SETTLE_MS);

  return (
    <Input
      {...inputProps}
      value={text}
      onChange={(event) => {
        latestText.current = event.target.value;
        setText(event.target.value);
        if (event.target.value === "") commit("");
        else scheduleCommit();
      }}
      onKeyDown={(event) => {
        inputProps.onKeyDown?.(event);
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit(text, true);
      }}
    />
  );
}
