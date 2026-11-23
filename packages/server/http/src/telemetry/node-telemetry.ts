import { register } from "node:module";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";

import { privacyFilteredExporter } from "./privacy-filtered-exporter.js";
import type { TelemetryOptions, TelemetryRuntime } from "./start-telemetry.js";
import { annotateRequest, currentTraceId } from "./trace-request.js";

export function openTelemetry(
  options: TelemetryOptions,
  endpoint: string,
): TelemetryRuntime {
  // The SDK catches CommonJS loads. The ESM hook also catches import of pg.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ "service.name": options.serviceName }),
    resourceDetectors: [envDetector],
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: privacyFilteredExporter(
          new OTLPTraceExporter({ url: endpoint }),
        ),
      }),
    ],
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();

  let closing: Promise<void> | undefined;
  return {
    annotateRequest,
    currentTraceId,
    shutdown: () => (closing ??= sdk.shutdown()),
  };
}
