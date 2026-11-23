import { register } from "node:module";

import type * as OtelApi from "@opentelemetry/api";
import type * as OtelExporter from "@opentelemetry/exporter-trace-otlp-proto";
import type * as OtelInstrumentation from "@opentelemetry/instrumentation";
import type * as OtelHttpInstrumentation from "@opentelemetry/instrumentation-http";
import type * as OtelPgInstrumentation from "@opentelemetry/instrumentation-pg";
import type * as OtelResources from "@opentelemetry/resources";
import type * as OtelSdkNode from "@opentelemetry/sdk-node";
import type * as OtelSdkTrace from "@opentelemetry/sdk-trace";

import { loadOptionalPeer } from "./optional-peer.js";
import { privacyFilteredExporter } from "./privacy-filtered-exporter.js";
import type { TelemetryOptions, TelemetryRuntime } from "./start-telemetry.js";

const TELEMETRY_SUBPATH = "@dads-framework/http/telemetry";

export type OpenTelemetryPeerLoaders = {
  readonly loadApi?: () => Promise<typeof OtelApi>;
  readonly loadExporter?: () => Promise<typeof OtelExporter>;
  readonly loadInstrumentation?: () => Promise<typeof OtelInstrumentation>;
  readonly loadHttpInstrumentation?: () => Promise<typeof OtelHttpInstrumentation>;
  readonly loadPgInstrumentation?: () => Promise<typeof OtelPgInstrumentation>;
  readonly loadResources?: () => Promise<typeof OtelResources>;
  readonly loadSdkNode?: () => Promise<typeof OtelSdkNode>;
  readonly loadSdkTrace?: () => Promise<typeof OtelSdkTrace>;
};

export async function loadOpenTelemetryPeers(loaders: OpenTelemetryPeerLoaders = {}) {
  const [api, exporter, instrumentation, httpInstrumentation, pgInstrumentation, resources, sdkNode, sdkTrace] =
    await Promise.all([
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/api",
        loaders.loadApi ?? (() => import("@opentelemetry/api")),
      ),
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/exporter-trace-otlp-proto",
        loaders.loadExporter ?? (() => import("@opentelemetry/exporter-trace-otlp-proto")),
      ),
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/instrumentation",
        loaders.loadInstrumentation ?? (() => import("@opentelemetry/instrumentation")),
      ),
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/instrumentation-http",
        loaders.loadHttpInstrumentation ?? (() => import("@opentelemetry/instrumentation-http")),
      ),
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/instrumentation-pg",
        loaders.loadPgInstrumentation ?? (() => import("@opentelemetry/instrumentation-pg")),
      ),
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/resources",
        loaders.loadResources ?? (() => import("@opentelemetry/resources")),
      ),
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/sdk-node",
        loaders.loadSdkNode ?? (() => import("@opentelemetry/sdk-node")),
      ),
      loadOptionalPeer(
        TELEMETRY_SUBPATH,
        "@opentelemetry/sdk-trace",
        loaders.loadSdkTrace ?? (() => import("@opentelemetry/sdk-trace")),
      ),
    ]);

  return {
    api,
    exporter,
    instrumentation,
    httpInstrumentation,
    pgInstrumentation,
    resources,
    sdkNode,
    sdkTrace,
  };
}

export async function openTelemetry(options: TelemetryOptions, endpoint: string): Promise<TelemetryRuntime> {
  const peers = await loadOpenTelemetryPeers();
  // The SDK catches CommonJS loads. The ESM hook also catches import of pg.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const { annotateRequest, currentTraceId } = await import("./trace-request.js");
  const sdk = new peers.sdkNode.NodeSDK({
    resource: peers.resources.resourceFromAttributes({
      "service.name": options.serviceName,
    }),
    resourceDetectors: [peers.resources.envDetector],
    spanProcessors: [
      new peers.sdkTrace.BatchSpanProcessor({
        exporter: privacyFilteredExporter(new peers.exporter.OTLPTraceExporter({ url: endpoint })),
      }),
    ],
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: [
      new peers.httpInstrumentation.HttpInstrumentation(),
      new peers.pgInstrumentation.PgInstrumentation({
        enhancedDatabaseReporting: false,
      }),
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
