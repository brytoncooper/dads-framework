/**
 * The seam every client reports a fault through.
 *
 * Vendor-neutral by construction: nothing here names a provider, and the
 * envelope it speaks is the contract's own `ClientDiagnosticEvent`. Swapping
 * what stands behind it — our own API today, a hosted aggregator later, both
 * at once — is a factory and an environment change, never a change to a call
 * site (`docs/architecture/engineering-principles.md`).
 *
 * Three rules the seam itself enforces:
 *
 * - **Reporting is fire-and-forget.** `reportError` returns `void`. A caller
 *   in a `catch` or a React error callback has a user waiting; it must never
 *   be able to await telemetry, and telemetry must never be able to reject
 *   into a path that was already handling a failure.
 * - **Reporting cannot throw.** Every driver swallows its own faults. A
 *   reporter that threw inside an error handler would replace a diagnosable
 *   fault with an undiagnosable one.
 * - **There is no `identify`.** Who the user is comes from the session the
 *   server already resolved, so a client never asserts an identity it would
 *   then be trusted on, and no principal data has to live in the browser for
 *   telemetry's sake.
 */

import type {
  ClientDiagnosticBreadcrumb,
  ClientDiagnosticEvent,
} from "@dads-framework/contract";

/** What the caller knows about the fault that the error itself does not. */
export type TelemetryContext = {
  /** Where the client was — the contract's own vocabulary. */
  readonly kind: ClientDiagnosticEvent["kind"];
  readonly severity?: ClientDiagnosticEvent["severity"];
  /** The API call this fault was about, when there was one. */
  readonly requestId?: string;
};

export type TelemetryBreadcrumb = ClientDiagnosticBreadcrumb;

export abstract class ClientTelemetry {
  /** Report a fault. Never throws, never returns a promise to await. */
  abstract reportError(error: unknown, context: TelemetryContext): void;

  /** Remember something that happened just before a fault might. */
  abstract addBreadcrumb(crumb: TelemetryBreadcrumb): void;

  /**
   * Deliver whatever is buffered, within `timeoutMs`.
   *
   * Resolves `true` when everything buffered was delivered and `false`
   * otherwise — including on timeout. It never rejects: a failed flush is
   * information, not an error to handle.
   */
  abstract flush(timeoutMs: number): Promise<boolean>;
}
