/**
 * The `onResponse` capture.
 *
 * `onResponse` and no other hook: it is the only one that runs for EVERY
 * answer this process gives — a matched route, a 404 from the not-found
 * handler, the 426 client gate, a 429, whatever the error handler wrote, and
 * the protocol mounts (`/api/auth`, `/scim/v2`) that never enter the route
 * pipeline at all. It is also the only one that can read the final status and
 * `reply.elapsedTime`.
 *
 * It runs after the client already has its answer, so nothing here is allowed
 * to matter: a throw is caught and logged, and the row is dropped.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { currentAuditActor } from "@dads-framework/audit-actor";
import type { DiagnosticsReporter } from "@dads-framework/diagnostics";
import { requestWorkOf } from "@dads-framework/request-work";

import { requestIdOf } from "../request-pipeline/request-id.js";
import type {
  AuthorizationWarningFaults,
  RecordedWarningFault,
} from "./authorization-warning-faults.js";
import type { RequestLogSink } from "./request-log-sink.js";
import { requestOutcomeOf } from "./request-outcome.js";
import { buildRequestRecord, type RequestRecord } from "./request-record.js";

export type RequestCaptureOptions = {
  /**
   * Where rows go, looked up per response rather than held.
   *
   * The capture has to be installed with the app — a hook added after a
   * plugin has booted is not inherited by it — but the sink belongs to the
   * composition root, which needs the app's logger before it can build one.
   * A lookup lets the app exist first and answer `undefined` in between.
   */
  readonly requestLog: (() => RequestLogSink | undefined) | undefined;
  readonly apiRelease: string | undefined;
  /** Which process answered — the container hostname, resolved once at boot. */
  readonly instanceId: string | undefined;
  /**
   * The trace in flight, asked per response.
   *
   * Injected rather than read here: this kit has no business depending on
   * OpenTelemetry, and a deployment that runs no tracing should not carry it.
   * The composition root supplies the one-line reader.
   */
  readonly currentTraceId?: () => string | undefined;
  /** Probe routes, the same set kept out of the log stream. */
  readonly quietPaths: ReadonlySet<string>;
  /**
   * Which authorization warnings the request tripped become a recorded fault
   * (rate-limited). Absent, warnings are not recorded.
   */
  readonly warningFaults?: AuthorizationWarningFaults;
  /** Where a recorded authorization warning is also reported, beside its row. */
  readonly diagnostics?: DiagnosticsReporter;
};

/**
 * An authorization guard the request tripped while still succeeding, built
 * only to be reported: it is never thrown at a caller.
 */
class AuthorizationGuardWarning extends Error {
  constructor(type: string, detail: string) {
    super(detail);
    this.name = type;
  }
}

/**
 * Methods that change nothing, and there are far more of them than everything
 * else. `OPTIONS` is here for the CORS preflight: the browser sends one before
 * the real request, it carries no credential and touches no resource, and the
 * request it asks about gets its own row a moment later.
 */
const NOTHING_CHANGED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function captureRequestRecord(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RequestCaptureOptions,
): void {
  try {
    const sink = options.requestLog?.();
    if (sink === undefined) return;
    const routePattern = request.routeOptions.url;
    if (isQuiet(routePattern, options.quietPaths)) return;
    const warningFault = recordWarningFault(request, routePattern, options);
    if (
      warningFault === undefined &&
      !isWorthRecording(request.method, reply.statusCode, sink)
    ) {
      return;
    }
    sink.record(rowFor(request, reply, routePattern, options, warningFault));
  } catch (error) {
    request.log.error(
      { event: "request-log.capture-failed", err: error },
      "request log capture failed",
    );
  }
}

function isQuiet(
  routePattern: string | undefined,
  quietPaths: ReadonlySet<string>,
): boolean {
  return routePattern !== undefined && quietPaths.has(routePattern);
}

/**
 * The warning the request's authorization guards noted, as the fault its row
 * records, when the rate limit lets it through. A recorded warning is also
 * logged and reported to diagnostics; a successful read that tripped one is
 * recorded although successful reads otherwise are not.
 */
function recordWarningFault(
  request: FastifyRequest,
  routePattern: string | undefined,
  options: RequestCaptureOptions,
): RecordedWarningFault | undefined {
  const warning = requestWorkOf(request)?.authzWarning;
  if (warning === undefined || options.warningFaults === undefined) {
    return undefined;
  }
  const fault = options.warningFaults.recordable(
    warning,
    routePattern,
    Date.now(),
  );
  if (fault === undefined) return undefined;
  const requestId = requestIdOf(request);
  request.log.warn(
    {
      event: "authorization.guard-warning",
      requestId,
      routeId: routePattern,
      type: fault.type,
      fingerprint: fault.fingerprint,
      detail: warning.detail,
    },
    "request tripped an authorization guard",
  );
  options.diagnostics?.captureException({
    error: new AuthorizationGuardWarning(fault.type, warning.detail),
    source: "request",
    // Nothing failed — the request answered — so it groups as a warning, by
    // the same per-warning-per-route key its row is grouped by.
    severity: "warning",
    fingerprint: fault.fingerprint,
    requestId,
    ...(routePattern === undefined ? {} : { routeId: routePattern }),
  });
  return fault;
}

/** Everything that changed something, plus everything that went wrong. */
function isWorthRecording(
  method: string,
  status: number,
  sink: RequestLogSink,
): boolean {
  if (sink.includeSuccessfulReads) return true;
  return !NOTHING_CHANGED_METHODS.has(method) || status >= 400;
}

/**
 * The notes the pipeline left, joined to what Fastify knows.
 *
 * The actor is read off the request rather than out of the ambient context:
 * `carryResolvedAuditActor` scopes the resolved actor to the handler, so by
 * now the context is back to the ingress `anonymous` one. The context is the
 * fallback for responses that never reached a handler.
 */
function rowFor(
  request: FastifyRequest,
  reply: FastifyReply,
  routePattern: string | undefined,
  options: RequestCaptureOptions,
  warningFault: RecordedWarningFault | undefined,
): RequestRecord {
  const outcome = requestOutcomeOf(request);
  return buildRequestRecord({
    requestId: requestIdOf(request),
    recordedAt: new Date(),
    method: request.method,
    url: request.url,
    routePattern,
    status: reply.statusCode,
    durationMs: Math.round(reply.elapsedTime),
    headers: request.headers,
    ip: request.ip,
    actor: outcome?.actor ?? currentAuditActor(),
    access: outcome?.access,
    errorCode: outcome?.errorCode,
    apiRelease: options.apiRelease,
    // Read off the request, not the ambient context: `onResponse` may run on
    // an async task that no longer belongs to the request that answered.
    work: requestWorkOf(request),
    instanceId: options.instanceId,
    traceId: options.currentTraceId?.(),
    // A thrown fault outranks a warning the same request noted earlier.
    exception: outcome?.exception ?? warningFault,
  });
}
