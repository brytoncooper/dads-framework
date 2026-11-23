import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

const EXPORTED_KEYS = new Set([
  "dads.request.id",
  "dads.audit.actor.kind",
  "db.system",
  "db.system.name",
  "http.method",
  "http.request.method",
  "http.status_code",
  "http.response.status_code",
  "network.protocol.version",
]);

/** Export only the fields that operators need to correlate and measure requests. */
export function privacyFilteredExporter(exporter: SpanExporter): SpanExporter {
  return {
    export: (spans, done) => {
      exporter.export(spans.map(withPublicSpanFields), done);
    },
    shutdown: () => exporter.shutdown(),
  };
}

function withPublicSpanFields(span: ReadableSpan): ReadableSpan {
  return {
    ...span,
    spanContext: () => span.spanContext(),
    name:
      span.instrumentationScope.name === "@opentelemetry/instrumentation-pg"
        ? "postgres.query"
        : span.name,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(([key]) => EXPORTED_KEYS.has(key)),
    ),
    status: { code: span.status.code },
    events: [],
    links: [],
  };
}
