import type { AuditActor } from "@dads-framework/core/audit-actor";

import { requestIdOf } from "./request-id.js";

/** Receives ingress correlation and the resolved audit actor's kind. */
export type RequestTrace = (facts: {
  readonly requestId: string;
  readonly actorKind: AuditActor["kind"];
}) => void;

const observers = new WeakMap<
  object,
  { readonly observe: RequestTrace; readonly requestId: string }
>();

export function beginRequestTrace(
  request: Parameters<typeof requestIdOf>[0],
  observer: RequestTrace | undefined,
): void {
  if (observer === undefined) return;
  const requestId = requestIdOf(request);
  observers.set(request, { observe: observer, requestId });
  annotate(observer, requestId, "anonymous");
}

export function annotateRequestActor(request: object, actor: AuditActor): void {
  const observer = observers.get(request);
  if (observer !== undefined) {
    annotate(observer.observe, observer.requestId, actor.kind);
  }
}

function annotate(
  observe: RequestTrace,
  requestId: string,
  actorKind: AuditActor["kind"],
): void {
  try {
    observe({ requestId, actorKind });
  } catch {
    // Observability is optional and cannot change request execution.
  }
}
