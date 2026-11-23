import { requestTraceAttributes, type RequestTraceFacts } from "../request-trace-attributes.js";

/** Records successive span attributes for a deterministic request-tracing test. */
export function recordRequestTrace() {
  const spans: Readonly<Record<string, string>>[] = [];
  return {
    annotateRequest: (facts: RequestTraceFacts): void => {
      spans.push(requestTraceAttributes(facts));
    },
    spans: (): readonly Readonly<Record<string, string>>[] => [...spans],
  };
}
