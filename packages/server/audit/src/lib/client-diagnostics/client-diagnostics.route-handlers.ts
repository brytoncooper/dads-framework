/**
 * The handler behind the report route.
 *
 * It reads the actor out of the request's own audit context rather than off
 * the body: the route is public, so identity on the wire is a claim, and the
 * context is what the server actually established. An anonymous report is
 * recorded as anonymous rather than refused — a fault on the login page is
 * exactly the kind this exists to hear about.
 */

import { currentAuditActor } from "@dads-framework/audit-actor";
import type { ReportClientDiagnosticsBody } from "@dads-framework/contract";

import type { RecordClientDiagnostics } from "./record-client-diagnostics.js";

/** What the handler needs from the request; `unknown` bodies never reach it. */
export type ClientDiagnosticsRequest = {
  readonly body: ReportClientDiagnosticsBody;
};

export class ClientDiagnosticsRouteHandlers {
  constructor(private readonly recorder: RecordClientDiagnostics) {}

  async reportClientDiagnostics(
    request: ClientDiagnosticsRequest,
  ): Promise<{ readonly accepted: number }> {
    const actor = currentAuditActor();
    return this.recorder.execute({
      events: request.body.events,
      actor: {
        kind: actor?.kind ?? "anonymous",
        id: actor?.id ?? "",
      },
    });
  }
}
