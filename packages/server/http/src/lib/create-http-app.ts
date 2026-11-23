import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import type { DestinationStream } from "pino";

import type { DiagnosticsReporter } from "@dads-framework/core/runtime/diagnostics";
import { beginRequestWork } from "@dads-framework/core/runtime/request-work";
import { ACCESS_REFUSAL_HEADER, REQUEST_ID_HEADER } from "@dads-framework/core/contract";

import { AuthorizationWarningFaults } from "./request-log/authorization-warning-faults.js";
import { captureRequestRecord } from "./request-log/capture-request-record.js";
import type { RequestLogSink } from "./request-log/request-log-sink.js";
import { enterAnonymousRequestActor } from "./request-pipeline/carry-audit-actor.js";
import { type ErrorHandlingOptions, installErrorHandling } from "./request-pipeline/error-handler.js";
import { resolveRequestId } from "./request-pipeline/request-id.js";
import { enterRequestOrigin } from "./request-pipeline/request-origin.js";
import { beginRequestTrace, type RequestTrace } from "./request-pipeline/request-trace.js";
import { acceptWebSocketUpgrades, isWebSocketRoutePath } from "./route/web-socket-route.js";

/**
 * Platform defaults for every HTTP app. The runaway-resource bounds are
 * numbers, not `number | false` — a caller can raise them for a special
 * deployment but can never disable them (process-discipline bar,
 * docs/plans/2026-07-09-remove-nest-http-kit.md).
 */
export type HttpAppOptions = {
  readonly nodeEnv: string;
  /** CORS origins allowed to send credentials. */
  readonly trustedOrigins: readonly string[];
  /**
   * Response headers a browser client may read, beyond the request id and
   * the access-refusal mark this kit always exposes. Which headers an app's own client speaks is that app's
   * wire contract, so the app names them.
   */
  readonly exposedHeaders?: readonly string[];
  /** false only via the test harness — production apps always log. */
  readonly logger?: boolean;
  /** A giant payload dies at the edge, not in V8. Default 1 MiB. */
  readonly bodyLimitBytes?: number;
  /** A hung handler cannot pin a socket forever. Default 30s. */
  readonly requestTimeoutMs?: number;
  /** Slow-loris connections die before their headers complete. Default 10s. */
  readonly headersTimeoutMs?: number;
  /**
   * How long a socket may sit with no traffic at all, which includes a
   * handler still working on its answer. Default 70s: past the 30s handler
   * deadline and past keep-alive, so neither is cut short.
   */
  readonly idleSocketTimeoutMs?: number;
  /** Above typical load-balancer idle (60s) so the LB closes first. Default 65s. */
  readonly keepAliveTimeoutMs?: number;
  /** Probe routes kept out of the log stream. */
  readonly quietPaths?: readonly string[];
  /**
   * Trusted reverse-proxy hops in front of this process (0 = none).
   * CloudFront + ALB is 2; ALB only is 1. Never `true` — that takes the
   * leftmost client-supplied X-Forwarded-For as `request.ip`.
   */
  readonly trustedProxyHops?: number;
  /**
   * Where the per-request row goes. A lookup rather than
   * the sink itself: the capture hook must be installed before any route or
   * protocol mount is registered, and the sink needs a database the
   * composition root builds after the app exists. Omit it and nothing is
   * captured.
   */
  readonly requestLog?: () => RequestLogSink | undefined;
  /** Build identity stamped on every captured row; null in the table until the image supplies one. */
  readonly apiRelease?: string;
  /**
   * Which process answered, stamped on every captured row. The
   * composition root resolves it once — a kit does not get to decide what a
   * deployment calls its instances.
   */
  readonly instanceId?: string;
  /**
   * Where a fault goes besides the log line. Omitted, faults are
   * logged exactly as they are today and reported nowhere.
   */
  readonly diagnostics?: DiagnosticsReporter;
  /**
   * Reads the trace in flight, when the deployment runs tracing at all. A
   * function so this kit never imports OpenTelemetry.
   */
  readonly currentTraceId?: () => string | undefined;
  /** Annotates the active span with the request ID and audit actor kind. */
  readonly requestTrace?: RequestTrace;
  /**
   * Body media types this app accepts as raw text.
   *
   * Fastify answers 415 for a content type it has no parser for, before any
   * handler runs — so a raw route receiving a format the typed verbs cannot
   * express (a newline-delimited telemetry envelope) needs its type
   * named here. The body arrives as the string it was sent as: this kit does
   * not learn any format, it only agrees to hand one through.
   *
   * Still under `bodyLimit`, like every other body.
   */
  readonly rawBodyContentTypes?: readonly string[];
  /**
   * Body media types this app accepts as raw bytes (a `Buffer`), for a raw
   * route that stores a file's bytes exactly as they were sent. Opt-in: an
   * app that names none answers 415 for these types, as before. Still under
   * `bodyLimit`, or the route's own `bodyLimitBytes`.
   */
  readonly byteBodyContentTypes?: readonly string[];
  /**
   * Where log lines go instead of stdout. Site process only; Vector never
   * sets it. Redaction runs before the stream. When set, the kit configures
   * no `transport` (pino refuses both at once): a caller that wants pretty
   * output in development puts it into its own stream.
   */
  readonly logStream?: DestinationStream;
};

/**
 * Agree to receive body types Fastify has no parser for, as the text they
 * arrived as.
 *
 * Its own function for the same reason as `errorHandlingFrom` below: the loop
 * would otherwise count against `createHttpApp`'s complexity budget, which is
 * what keeps the composition readable.
 */
function acceptRawBodies(app: FastifyInstance, contentTypes: readonly string[] | undefined): void {
  for (const contentType of contentTypes ?? []) {
    app.addContentTypeParser(contentType, { parseAs: "string" }, (_request, body, done) => {
      // Handed through exactly as received. Whatever reads it owns the
      // format; this kit owns only the fact that a body was allowed.
      done(null, body);
    });
  }
}

/**
 * Agree to receive body types as the bytes they arrived as. Its own function
 * for the same complexity reason as `acceptRawBodies`.
 */
function acceptByteBodies(app: FastifyInstance, contentTypes: readonly string[] | undefined): void {
  for (const contentType of contentTypes ?? []) {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => {
      // Handed through exactly as received; the route owns the bytes.
      done(null, body);
    });
  }
}

/**
 * The subset of the app's options the error handler needs, with the absent
 * ones left absent rather than passed as `undefined`. Its own function so the
 * three optional spreads do not count against `createHttpApp`'s complexity —
 * which is the budget that keeps the composition readable.
 */
function errorHandlingFrom(options: HttpAppOptions): ErrorHandlingOptions {
  return {
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.apiRelease === undefined ? {} : { release: options.apiRelease }),
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
  };
}

const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65_000;
const DEFAULT_IDLE_SOCKET_TIMEOUT_MS = 70_000;
const DEFAULT_QUIET_PATHS = ["/api/health", "/api/ready"];

/** Slow-loris bound: a client that never finishes its headers is dropped. */
function applyHeadersTimeout(app: FastifyInstance, options: HttpAppOptions): void {
  app.server.headersTimeout = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
}

/**
 * Pino options with credential redaction and an optional caller-supplied stream.
 */
function loggerOptionsFrom(options: HttpAppOptions): Exclude<FastifyServerOptions["logger"], undefined> {
  if (options.logger === false) return false;

  return {
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        // Verification and reset links carry credentials in the query string.
        url: request.url.split("?")[0] ?? "",
        host: request.host,
        remoteAddress: request.ip,
      }),
    },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
    },
    ...(options.logStream === undefined ? {} : { stream: options.logStream }),
  };
}

/**
 * Builds a Fastify instance carrying the house edge behavior: pino logging
 * with credential redaction, request-id correlation (inbound `x-request-id`
 * honored, always echoed), the error envelope handler, CORS for the trusted
 * origins, and the non-disableable resource bounds above.
 */
export async function createHttpApp(options: HttpAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptionsFrom(options),
    // resolveRequestId is the same ingress the old middleware used: trust a
    // sane inbound id, otherwise generate one.
    genReqId: (req) => resolveRequestId(req.headers[REQUEST_ID_HEADER]).id,
    requestIdHeader: false,
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    connectionTimeout: options.idleSocketTimeoutMs ?? DEFAULT_IDLE_SOCKET_TIMEOUT_MS,
    keepAliveTimeout: options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    // close() destroys idle sockets instead of waiting on keep-alive — a
    // deploy drains in-flight work and exits, never hangs on idle clients.
    forceCloseConnections: "idle",
    trustProxy: options.trustedProxyHops ?? 0,
  });
  applyHeadersTimeout(app, options);

  // The first hook Fastify runs, so everything downstream inherits all four:
  // correlation egress (every response carries the id, success or error), the
  // anonymous audit-actor context that keeps a pre-authentication write —
  // Better Auth's login rows, SCIM's first touch — from reaching the
  // `audit_record` trigger unattributed, the work tally the
  // pool and the authorization port charge into, and the origin the request
  // reached the server on (`requestOriginOr`).
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    enterAnonymousRequestActor(request);
    beginRequestTrace(request, options.requestTrace);
    beginRequestWork(request);
    enterRequestOrigin(request);
    done();
  });

  const quiet = new Set(options.quietPaths ?? DEFAULT_QUIET_PATHS);
  const warningFaults = new AuthorizationWarningFaults();
  app.addHook("onRoute", (route) => {
    if (quiet.has(route.url)) {
      route.logLevel = "silent";
    }
    // The first WebSocket route makes the app route upgrades through Fastify.
    if (route.method === "GET" && isWebSocketRoutePath(route.url)) {
      acceptWebSocketUpgrades(app);
    }
  });

  // Registered here, before the protocol mounts and the route table, because
  // a hook added to the root after a plugin has booted is not inherited by
  // it — and a request row that missed `/api/auth` would miss exactly the
  // requests with no subject to identify them by.
  app.addHook("onResponse", (request, reply, done) => {
    captureRequestRecord(request, reply, {
      requestLog: options.requestLog,
      apiRelease: options.apiRelease,
      instanceId: options.instanceId,
      ...(options.currentTraceId === undefined ? {} : { currentTraceId: options.currentTraceId }),
      quietPaths: quiet,
      warningFaults,
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    });
    done();
  });

  acceptRawBodies(app, options.rawBodyContentTypes);
  acceptByteBodies(app, options.byteBodyContentTypes);

  installErrorHandling(app, errorHandlingFrom(options));

  await app.register(cors, {
    origin: [...options.trustedOrigins],
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER, ACCESS_REFUSAL_HEADER, ...(options.exposedHeaders ?? [])],
  });

  return app;
}
