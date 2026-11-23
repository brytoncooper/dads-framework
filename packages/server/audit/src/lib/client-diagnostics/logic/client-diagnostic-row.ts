/**
 * One reported fault, as the table wants it.
 *
 * Pure on purpose: everything this decides is a rule about trust, and a rule
 * about trust should be provable without a database. Three of them live here.
 *
 * - **The actor is the server's, never the client's.** A report arrives on a
 *   public route, so anything it claims about identity is a claim. The actor
 *   comes from the request's own context, which is why it is a parameter and
 *   not a field of the event.
 * - **`occurredAt` is the client's clock and is kept as such.** It is useful
 *   (it orders a burst) and untrustworthy (a device can be hours out), so it
 *   is stored beside `recorded_at` rather than instead of it.
 * - **The id is minted here.** A client-supplied id would let one page
 *   overwrite another's row, or collide on purpose.
 */

import type { ClientDiagnosticEvent } from "@dads-framework/core/contract";

import type { ClientDiagnosticRow } from "../../database/writers/client-diagnostic-writer.interface.js";
import type { ClientDiagnosticEventId } from "../client-diagnostic-event.ids.js";

/** What the request knows that the report does not get to claim. */
export type ReportingActor = {
  readonly kind: string;
  readonly id: string;
};

export function clientDiagnosticRow(input: {
  readonly event: ClientDiagnosticEvent;
  readonly actor: ReportingActor;
  readonly id: ClientDiagnosticEventId;
}): ClientDiagnosticRow {
  const { event } = input;
  return {
    id: input.id,
    occurredAt: new Date(event.occurredAt),
    fingerprint: event.fingerprint,
    kind: event.kind,
    severity: event.severity,
    name: event.name,
    message: event.message,
    frames: event.frames,
    breadcrumbs: event.breadcrumbs,
    release: event.release,
    // The envelope's own statement of which client it is; `unknown` when the
    // report carried no context, which a very early failure legitimately may.
    client: event.context?.client ?? "unknown",
    requestId: event.requestId ?? null,
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    context: event.context ?? null,
  };
}
