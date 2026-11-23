/**
 * The two faults that reach no framework callback.
 *
 * React tells the app about errors thrown while rendering, and the data layer
 * tells it about failed queries and mutations. Neither sees an exception from
 * an event handler, a `setTimeout`, or a promise nobody awaited — those go to
 * `window`, and without these two listeners they go nowhere at all.
 *
 * A function in the library rather than four lines in `main.tsx`, because the
 * app is composition only and because the rules about what to report belong
 * beside the other rules about what to report.
 */

import type { ClientTelemetry } from "../core/index.js";
import { isChunkLoadFailure } from "./logic/is-chunk-load-failure.js";
import { shouldReportFailure } from "./logic/should-report-failure.js";

export type GlobalErrorReportingOptions = {
  readonly telemetry: ClientTelemetry;
  /** Where listeners attach; injected so a test needs no DOM. */
  readonly target: Pick<Window, "addEventListener" | "removeEventListener">;
  /**
   * Asked whenever a chunk fails to load. A deploy replacing the bundle under
   * an open tab is the ordinary cause and is not a fault; returning `true`
   * says the reload path has this and the fault should not be reported.
   */
  readonly staleBuildExplains?: () => boolean;
};

/** Installs the listeners and returns the function that removes them. */
export function installGlobalErrorReporting(
  options: GlobalErrorReportingOptions,
): () => void {
  const report = (
    error: unknown,
    kind: "window-error" | "unhandled-rejection",
  ) => {
    if (isChunkLoadFailure(error)) {
      if (options.staleBuildExplains?.() === true) return;
      // The reload path did NOT explain it, so this is the rare real one: a
      // bad deploy or a broken asset path, and exactly worth waking up for.
      options.telemetry.reportError(error, { kind: "chunk-load" });
      return;
    }
    if (shouldReportFailure(error) !== "report") return;
    options.telemetry.reportError(error, { kind });
  };

  const onError = (event: ErrorEvent): void => {
    report(event.error ?? event.message, "window-error");
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    report(event.reason, "unhandled-rejection");
  };

  options.target.addEventListener("error", onError);
  options.target.addEventListener("unhandledrejection", onRejection);
  return () => {
    options.target.removeEventListener("error", onError);
    options.target.removeEventListener("unhandledrejection", onRejection);
  };
}
