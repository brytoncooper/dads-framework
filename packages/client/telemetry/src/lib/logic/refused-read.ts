/**
 * A page read something its user may not read.
 *
 * `shouldReportFailure` keeps refusals out of telemetry because a refused
 * WRITE is the product saying no. A refused READ is different: the page was
 * opened, so its user was meant to see it, and a page that reads past what
 * opened it shows a default or an empty list instead of the truth, silently.
 * That is a defect in the page, so it is reported, once per call, whether or
 * not the screen handled the error (docs/enforcement.md, "Refused page reads").
 *
 * Only answers the access edge marked (`x-access-refusal: refused`, read by
 * the transport into `refusedForAccess`) count; a handler's plain 404 for a
 * record it did not find never does. The edge cannot tell a record removed
 * since the page loaded from one the user may not reach (both have no
 * relationship to check), so a stale link can raise one of these too; the
 * message says so.
 */

import type { ApiExchange } from "@dads-framework/client-request-transport";

export class RefusedReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedReadError";
  }
}

/** Ids (uuids, long numbers) in a path, so one read groups as one issue. */
const ID_SEGMENT = /\/(?:[0-9a-f]{8}-[0-9a-f-]{27}|\d{4,})(?=\/|$)/gi;

/** The error to report for an exchange, or null when it is not a refused read. */
export function refusedReadOf(exchange: ApiExchange): RefusedReadError | null {
  if (exchange.method !== "GET" || !exchange.refusedForAccess) return null;
  const path = exchange.path.replace(ID_SEGMENT, "/:id");
  return new RefusedReadError(
    `Refused read: GET ${path} answered a marked ${String(exchange.status)} to a page its user opened (or the record was removed since the page loaded)`,
  );
}
