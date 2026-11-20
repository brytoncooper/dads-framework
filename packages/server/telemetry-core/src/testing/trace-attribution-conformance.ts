import type { RequestTraceFacts } from "../request-trace-attributes.js";

type TraceAttributionCase = {
  readonly name: string;
  readonly facts: RequestTraceFacts;
  readonly attributes: Readonly<Record<string, string>>;
};

export const traceAttributionCases: readonly TraceAttributionCase[] = [
  {
    name: "valid correlation ID",
    facts: { requestId: "request-proof-1", actorKind: "user" },
    attributes: {
      "dads.audit.actor.kind": "user",
      "dads.request.id": "request-proof-1",
    },
  },
  {
    name: "invalid correlation ID",
    facts: { requestId: "invalid private text", actorKind: "user" },
    attributes: { "dads.audit.actor.kind": "user" },
  },
];
