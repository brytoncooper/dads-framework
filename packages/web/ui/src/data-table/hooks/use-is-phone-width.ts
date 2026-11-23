import * as React from "react";

/** Below Tailwind's `md` breakpoint, where a table row becomes a card. */
const PHONE_WIDTH_QUERY = "(max-width: 767.98px)";

/**
 * Whether the viewport is phone-width. Read synchronously on first render, so
 * a phone never flashes the wide table before its cards; false where the
 * browser cannot answer (no `matchMedia`).
 */
export function useIsPhoneWidth(): boolean {
  return React.useSyncExternalStore(subscribeToPhoneWidth, readIsPhoneWidth, readIsPhoneWidthOnServer);
}

function subscribeToPhoneWidth(onChange: () => void): () => void {
  const query = readPhoneWidthQuery();
  if (query === null) return () => undefined;
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function readIsPhoneWidth(): boolean {
  return readPhoneWidthQuery()?.matches ?? false;
}

function readIsPhoneWidthOnServer(): boolean {
  return false;
}

function readPhoneWidthQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(PHONE_WIDTH_QUERY);
}
