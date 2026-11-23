/**
 * What the request pipeline learned that the response no longer shows.
 *
 * By the time `onResponse` runs, a denial is an anonymous 404 and a validation
 * failure is a 400 with a body already on the wire — the permission that was
 * checked, the credential that answered, and the envelope's error code are all
 * gone. The stages that DO know them leave a note here, keyed by the request
 * object itself.
 *
 * A `WeakMap` rather than a Fastify decorator: the kit augments no Fastify
 * type today, and a decorator would put a diagnostic field on every request
 * whether or not an app captures anything. The map holds no reference of its
 * own, so a request that ends without a note is collected exactly as before.
 */

import type { AuditActor } from "@dads-framework/core/audit-actor";
import type { AccessDecision } from "../request-pipeline/enforce-access.js";
import { annotateRequestActor } from "../request-pipeline/request-trace.js";
import type { RouteAccess } from "../route/access.js";
import type { RequestAccessFacts } from "./request-record.js";

export type RequestOutcome = {
  readonly actor?: AuditActor;
  readonly access?: RequestAccessFacts;
  readonly errorCode?: string;
  readonly exception?: { readonly type: string; readonly fingerprint: string };
};

const outcomes = new WeakMap<object, RequestOutcome>();

/**
 * Keep the actor the request resolved to.
 *
 * `runWithAuditActor` scopes the resolved actor to the handler, so by
 * `onResponse` the ambient context is back to the ingress `anonymous` one.
 * Reading the actor off the request instead of the context is the difference
 * between a row that says `user` and a row that says nobody.
 */
export function rememberRequestActor(request: object, actor: AuditActor): void {
  amend(request, { actor });
  annotateRequestActor(request, actor);
}

/** Freeze what access settled, before the handler turns it into a status. */
export function rememberAccessOutcome(request: object, access: RouteAccess, decision: AccessDecision): void {
  amend(request, { access: describeAccess(access, decision) });
}

/** Keep the envelope's `code`, the one part of an error body worth a column. */
export function rememberErrorCode(request: object, errorCode: string): void {
  amend(request, { errorCode });
}

/**
 * Keep what actually failed.
 *
 * `errorCode` is `INTERNAL_ERROR` for every unexpected fault — exactly the set
 * worth investigating and exactly the set it cannot tell apart. The type and
 * fingerprint can.
 */
export function rememberException(
  request: object,
  exception: { readonly type: string; readonly fingerprint: string },
): void {
  amend(request, { exception });
}

export function requestOutcomeOf(request: object): RequestOutcome | undefined {
  return outcomes.get(request);
}

function amend(request: object, note: RequestOutcome): void {
  outcomes.set(request, { ...outcomes.get(request), ...note });
}

/**
 * The decision as the row wants it.
 *
 * A refusal carries no resolved facts — that is the point of failing closed —
 * so it reports what the ROUTE declared instead: which kind of access was
 * asked for, and on a permission or visibility route, which permission. Those
 * are facts about the code, not about the caller, and they are what turns "a
 * 404" into "that caller lacked orders.read on organizations/order".
 */
function describeAccess(access: RouteAccess, decision: AccessDecision): RequestAccessFacts {
  if (decision.outcome !== "allow") {
    return {
      outcome: decision.outcome,
      accessKind: access.kind,
      ...declared(access),
    };
  }
  return {
    outcome: "allow",
    accessKind: decision.accessKind,
    ...(decision.permission === undefined ? {} : { permission: decision.permission }),
    ...(decision.resource === undefined
      ? {}
      : {
          resourceType: decision.resource.type,
          resourceId: decision.resource.id,
        }),
    ...(decision.authMethod === undefined ? {} : { authMethod: decision.authMethod }),
  };
}

/** The permission a route declares statically, for the paths that never got one. */
function declared(access: RouteAccess): {
  permission?: string;
  resourceType?: string;
} {
  if (access.kind === "permission" || access.kind === "visibility" || access.kind === "scoped") {
    return { permission: access.permission, resourceType: access.resourceType };
  }
  return {};
}
