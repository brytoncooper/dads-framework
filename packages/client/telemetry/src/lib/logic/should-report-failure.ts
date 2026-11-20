/**
 * What is worth waking someone for.
 *
 * The judgement that keeps this system from becoming noise, and the reason it
 * is a pure function with its own tests rather than a condition buried in a
 * handler.
 *
 * The rule underneath every row below: **report faults, not refusals.** A
 * server saying "no" is the product working. A client that cannot reach the
 * network is the world working. Neither is a defect, and a telemetry stream
 * full of them is a stream nobody reads — which costs more than having none.
 */

import {
  ApiError,
  UnauthorizedError,
  NetworkError,
} from "@dads-framework/client-request-transport";

/**
 * `report` becomes an event. `breadcrumb` is remembered but never sent on its
 * own — it gives the next real fault its context. `ignore` is dropped.
 */
export type FailureVerdict = "report" | "breadcrumb" | "ignore";

const SERVER_FAULT_STATUS = 500;

export function shouldReportFailure(error: unknown): FailureVerdict {
  // An expired session is the most common "failure" in any authenticated app
  // and is already handled end to end by returning the user to login.
  if (error instanceof UnauthorizedError) return "ignore";

  if (error instanceof ApiError) {
    // 4xx is the API working: the request was wrong, or not allowed, or the
    // thing was not there. The server already recorded the decision in
    // `request_log`; reporting it again from the browser adds nothing.
    return error.status >= SERVER_FAULT_STATUS ? "report" : "ignore";
  }

  // Offline is a first-class state here — kiosks and plant-local deployments
  // are disconnected by design — so a network failure is context for whatever
  // comes next, not an event of its own.
  if (error instanceof NetworkError) return "breadcrumb";

  // An aborted request is a navigation or a cancelled query, not a fault.
  if (isAbort(error)) return "ignore";

  return "report";
}

function isAbort(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return error instanceof Error && error.name === "AbortError";
}
