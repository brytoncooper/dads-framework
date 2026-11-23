import { isSpanContextValid, trace } from "@opentelemetry/api";

import { requestTraceAttributes, type RequestTraceFacts } from "./core/index.js";

export function annotateRequest(facts: RequestTraceFacts): void {
  trace.getActiveSpan()?.setAttributes(requestTraceAttributes(facts));
}

export function currentTraceId(): string | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  return context !== undefined && isSpanContextValid(context) ? context.traceId : undefined;
}
