/**
 * Who tells the reader that a write failed.
 *
 * The web app shows one global notice for every failed write, so no caller has
 * to remember to. A screen that already shows the refusal where it happened —
 * beside the field, in the dialog, on the row — declares so with
 * `FAILURE_PRESENTED_INLINE` as its mutation `meta`, and the global notice
 * stands down. Without the declaration the reader would get the same refusal
 * twice, once in context and once as a less specific toast.
 *
 * The declaration belongs to the hook whose every consumer renders the
 * failure. A hook with a consumer that does not render it stays undeclared.
 */
export type FailurePresentationMeta = {
  readonly failurePresentation: "inline";
};

/** Mutation `meta` for a write whose screen presents its own failure. */
export const FAILURE_PRESENTED_INLINE: FailurePresentationMeta = {
  failurePresentation: "inline",
};

/** True when a mutation's `meta` says its screen presents the failure. */
export function isFailurePresentedInline(meta: unknown): boolean {
  return (
    typeof meta === "object" &&
    meta !== null &&
    "failurePresentation" in meta &&
    meta.failurePresentation === "inline"
  );
}
