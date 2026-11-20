/**
 * Where a server fault goes.
 *
 * Today a 500 produces exactly one thing: a pino line at the HTTP error
 * handler carrying the stack. Nothing groups it, nothing counts it, nothing
 * notices when a new one starts, and it survives only as long as log
 * retention. `request_log.error_code` says a request failed; it cannot say
 * what failed or whether it is the same thing that failed yesterday.
 *
 * This is the seam that closes that, and it names no vendor. The drivers
 * decide where a fault goes; `none` sends it nowhere, which is the posture
 * for plant-local deployments that have no aggregator and no operator
 * watching one.
 *
 * Two rules the seam itself enforces:
 *
 * - **Capturing returns `void` and never throws.** Every caller is already
 *   handling a failure — an error handler, a fatal signal, a failed job — and
 *   none of them can afford a second one or an await.
 * - **No stack and no message ever reaches a database column.** A message is
 *   an exception's own text and can quote whatever a user typed. What lands
 *   in `request_log` is the exception's TYPE and a FINGERPRINT; the stack
 *   stays in the log line, keyed by the same request id.
 */

/** Where the fault happened, in the vocabulary the log lines already use. */
export type FaultSource = "request" | "job" | "process";

/**
 * How bad it is. `fatal` is a poisoned process, `warning` a guard that tripped
 * without failing anything, `error` everything else.
 */
export type FaultSeverity = "fatal" | "error" | "warning";

export type FaultEvent = {
  readonly error: unknown;
  readonly source: FaultSource;
  /** Absent means `fatal` for a `process` fault and `error` otherwise. */
  readonly severity?: FaultSeverity;
  /**
   * The group key, when the caller already owns one — a guard warning is
   * grouped per warning and route, not per stack. Absent means the one
   * `describeException` derives.
   */
  readonly fingerprint?: string;
  /** Correlates to `request_log` and `audit_log`; absent for a process fatal. */
  readonly requestId?: string;
  /** The matched route pattern, never a concrete url. */
  readonly routeId?: string;
  readonly jobName?: string;
  /** Who the request resolved to, as kind and id — never a name or an email. */
  readonly actor?: { readonly kind: string; readonly id: string };
  /** The build that failed, when the deployment supplies one. */
  readonly release?: string;
  /** Which process answered — the container hostname. */
  readonly instanceId?: string;
};

/** The severity a fault is reported at when its caller did not name one. */
export function severityOf(event: FaultEvent): FaultSeverity {
  if (event.severity !== undefined) return event.severity;
  return event.source === "process" ? "fatal" : "error";
}

export abstract class DiagnosticsReporter {
  /** Report a fault. Never throws, never returns a promise to await. */
  abstract captureException(event: FaultEvent): void;

  /**
   * Deliver whatever is buffered, within `timeoutMs`.
   *
   * Resolves `true` when everything buffered was delivered and `false`
   * otherwise, including on timeout. It never rejects: the caller is usually
   * a process on its way out, and a failed flush must not turn a clean exit
   * into a failed one.
   */
  abstract flush(timeoutMs: number): Promise<boolean>;

  abstract close(): Promise<void>;
}
