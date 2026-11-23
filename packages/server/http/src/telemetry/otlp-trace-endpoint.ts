/** Resolve the configured OTLP HTTP trace URL without the SDK's implicit default. */
export function otlpTraceEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  if (env["OTEL_SDK_DISABLED"]?.trim().toLowerCase() === "true") return undefined;
  if (env["OTEL_TRACES_EXPORTER"]?.trim().toLowerCase() === "none") return undefined;

  const traces = env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]?.trim();
  const base = env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim();
  if (traces) return parseHttpEndpoint(traces).href;
  if (!base) return undefined;

  const endpoint = parseHttpEndpoint(base);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/traces`;
  return endpoint.href;
}

function parseHttpEndpoint(value: string): URL {
  const error = new Error("The OTLP endpoint must be an HTTP or HTTPS URL.");
  if (!URL.canParse(value)) throw error;
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw error;
  }
  return endpoint;
}
