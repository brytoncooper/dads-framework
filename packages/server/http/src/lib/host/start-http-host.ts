import type { FastifyInstance } from "fastify";

import type { FetchHandler } from "@dads-framework/core/contract";

import { createHealthRoutes, type ReadinessChecks } from "../../health/lib/health.routes.js";
import {
  mountFetchHandler,
  type ProtocolMountOptions,
} from "../../protocol-mounts/lib/protocol-mount/mount-fetch-handler.js";
import { createHttpApp, type HttpAppOptions } from "../create-http-app.js";
import { registerRoutes, type RegisterRoutesOptions } from "../request-pipeline/register-routes.js";
import type { RequestTrace } from "../request-pipeline/request-trace.js";
import type { HttpRoute } from "../route/route-group.js";

/** Readiness probes mounted as `/health` and `/ready` under the host's `apiPrefix`. */
export type HttpHostHealthOptions = ReadinessChecks;

/** A fetch-style protocol handler mounted whole under a literal URL prefix. */
export type HttpProtocolMount = {
  readonly prefix: string;
  readonly handler: FetchHandler | FetchHandler["handler"];
  readonly options?: ProtocolMountOptions;
};

/** Tracing hooks passed from `@dads-framework/http/telemetry` without coupling the host to OpenTelemetry. */
export type HttpHostTelemetry = {
  readonly currentTraceId: () => string | undefined;
  readonly annotateRequest: RequestTrace;
};

/** Composable configuration for booting a Fastify HTTP host with routes, mounts, probes, and cleanup. */
export type HttpHostOptions = Omit<HttpAppOptions, "nodeEnv" | "trustedOrigins" | "currentTraceId" | "requestTrace"> &
  Omit<RegisterRoutesOptions, "routes"> & {
    /** Public origin or base URL of the host; becomes the default trusted CORS origin. */
    readonly baseUrl: string;
    /** Explicit CORS origins allowed to send credentials. Defaults to `[baseUrl]`. */
    readonly trustedOrigins?: readonly string[];
    /** Runtime environment label. Defaults to `process.env["NODE_ENV"] ?? "development"`. */
    readonly nodeEnv?: string;
    /** Optional telemetry hooks wired to request correlation and tracing. */
    readonly telemetry?: HttpHostTelemetry;
    /** Optional liveness (`/health`) and readiness (`/ready`) probes mounted under `apiPrefix`. */
    readonly health?: HttpHostHealthOptions;
    /** Fetch-style protocol mounts registered before the typed API routes. */
    readonly mounts?: readonly HttpProtocolMount[];
    /** URL prefix for registered API and health routes. Defaults to `"/api"`. */
    readonly apiPrefix?: string;
    /** Grouped HTTP routes to mount under `apiPrefix`. */
    readonly routes: readonly HttpRoute[];
    /** Cleanup hook invoked when the Fastify instance closes, including on startup rollback. */
    readonly onClose?: () => void | Promise<void>;
  };

/**
 * Assemble and ready a Fastify HTTP host with CORS, protocol mounts, typed routes,
 * optional health probes, and rollback on startup failure.
 */
export async function startHttpHost(options: HttpHostOptions): Promise<FastifyInstance> {
  const http = await createHttpApp(buildHttpAppOptions(options));
  if (options.onClose !== undefined) {
    const onClose = options.onClose;
    http.addHook("onClose", () => Promise.resolve(onClose()));
  }
  try {
    for (const mount of options.mounts ?? []) {
      void http.register(mountFetchHandler(toFetchHandler(mount.handler), mount.options), {
        prefix: mount.prefix,
      });
    }
    const allRoutes =
      options.health === undefined ? options.routes : [...options.routes, ...createHealthRoutes(options.health)];
    const routeOptions = buildRegisterRoutesOptions(options, allRoutes);
    void http.register(
      (api) =>
        Promise.resolve().then(() => {
          registerRoutes(api, routeOptions);
        }),
      { prefix: options.apiPrefix ?? "/api" },
    );
    await http.ready();
    return http;
  } catch (fault) {
    await http.close();
    throw fault;
  }
}

function toFetchHandler(handler: FetchHandler | FetchHandler["handler"]): FetchHandler {
  return typeof handler === "function" ? { handler } : handler;
}

function buildHttpAppOptions(options: HttpHostOptions): HttpAppOptions {
  return {
    nodeEnv: options.nodeEnv ?? process.env["NODE_ENV"] ?? "development",
    trustedOrigins: options.trustedOrigins ?? [options.baseUrl],
    ...buildHttpAppLimits(options),
    ...buildHttpAppEdgeOptions(options),
    ...buildHttpAppObservability(options),
  };
}

function buildHttpAppLimits(options: HttpHostOptions): Partial<HttpAppOptions> {
  return {
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.headersTimeoutMs === undefined ? {} : { headersTimeoutMs: options.headersTimeoutMs }),
    ...(options.idleSocketTimeoutMs === undefined ? {} : { idleSocketTimeoutMs: options.idleSocketTimeoutMs }),
    ...(options.keepAliveTimeoutMs === undefined ? {} : { keepAliveTimeoutMs: options.keepAliveTimeoutMs }),
    ...(options.trustedProxyHops === undefined ? {} : { trustedProxyHops: options.trustedProxyHops }),
  };
}

function buildHttpAppEdgeOptions(options: HttpHostOptions): Partial<HttpAppOptions> {
  return {
    ...(options.exposedHeaders === undefined ? {} : { exposedHeaders: options.exposedHeaders }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.quietPaths === undefined ? {} : { quietPaths: options.quietPaths }),
    ...(options.rawBodyContentTypes === undefined ? {} : { rawBodyContentTypes: options.rawBodyContentTypes }),
    ...(options.byteBodyContentTypes === undefined ? {} : { byteBodyContentTypes: options.byteBodyContentTypes }),
    ...(options.logStream === undefined ? {} : { logStream: options.logStream }),
  };
}

function buildHttpAppObservability(options: HttpHostOptions): Partial<HttpAppOptions> {
  return {
    ...(options.requestLog === undefined ? {} : { requestLog: options.requestLog }),
    ...(options.apiRelease === undefined ? {} : { apiRelease: options.apiRelease }),
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.telemetry === undefined
      ? {}
      : {
          currentTraceId: options.telemetry.currentTraceId,
          requestTrace: options.telemetry.annotateRequest,
        }),
  };
}

function buildAccessPorts(
  options: HttpHostOptions,
): Pick<RegisterRoutesOptions, "subjects" | "authorization" | "lookups" | "authorizationContexts" | "onDenied"> {
  return {
    subjects: options.subjects,
    authorization: options.authorization,
    ...(options.lookups === undefined ? {} : { lookups: options.lookups }),
    ...(options.authorizationContexts === undefined ? {} : { authorizationContexts: options.authorizationContexts }),
    ...(options.onDenied === undefined ? {} : { onDenied: options.onDenied }),
  };
}

function buildRegisterRoutesOptions(options: HttpHostOptions, routes: readonly HttpRoute[]): RegisterRoutesOptions {
  return {
    routes,
    ...buildAccessPorts(options),
    ...(options.accessModel === undefined ? {} : { accessModel: options.accessModel }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: options.handlerTimeoutMs }),
    ...(options.auditActorForSubject === undefined ? {} : { auditActorForSubject: options.auditActorForSubject }),
    ...(options.featureState === undefined ? {} : { featureState: options.featureState }),
    ...(options.machineCredentials === undefined ? {} : { machineCredentials: options.machineCredentials }),
  };
}
