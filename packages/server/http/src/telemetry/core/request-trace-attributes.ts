/** Request facts the HTTP host can safely submit for trace attribution. */
export type RequestTraceFacts = {
  readonly requestId: string;
  readonly actorKind: string;
};

/** A bounded correlation token so arbitrary header text does not leave the process. */
const TRACE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Convert request facts to vendor-independent span attributes. */
export function requestTraceAttributes(facts: RequestTraceFacts): Readonly<Record<string, string>> {
  const attributes = { "dads.audit.actor.kind": facts.actorKind };
  return TRACE_REQUEST_ID.test(facts.requestId) ? { ...attributes, "dads.request.id": facts.requestId } : attributes;
}
