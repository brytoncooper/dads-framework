import { otlpTraceEndpoint } from "./otlp-trace-endpoint.js";
import type { RequestTraceFacts } from "./core/index.js";

/** Identity used when OTEL_SERVICE_NAME does not override it. */
export type TelemetryOptions = {
  readonly serviceName: string;
};

/** Process-owned tracing lifecycle and HTTP hooks. */
export type TelemetryRuntime = {
  readonly annotateRequest: (facts: RequestTraceFacts) => void;
  readonly currentTraceId: () => string | undefined;
  readonly shutdown: () => Promise<void>;
};

let started: Promise<TelemetryRuntime> | undefined;

/** Start instrumentation before importing HTTP servers and database clients. */
export async function startTelemetry(options: TelemetryOptions): Promise<TelemetryRuntime | undefined> {
  const endpoint = otlpTraceEndpoint(process.env);
  if (endpoint === undefined) return undefined;
  started ??= import("./node-telemetry.js")
    .then(({ openTelemetry }) => openTelemetry(options, endpoint))
    .catch((error: unknown) => {
      started = undefined;
      throw error;
    });
  return started;
}
