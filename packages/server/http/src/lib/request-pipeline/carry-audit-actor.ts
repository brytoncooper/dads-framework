/**
 * The HTTP end of the actor context: who the database believes is
 * writing, for the whole of a request.
 *
 * Two moments, because a request has two answers to "who is this":
 *
 * 1. **Ingress**, before anything has authenticated: `anonymous` with the
 *    request id. This is not a formality — Better Auth's login flow writes
 *    `session` and `user` rows on a request that by definition has no subject
 *    yet, and the `audit_record` trigger refuses any write that reaches it
 *    unattributed. Without this the login endpoint would 500.
 * 2. **After access enforcement decides**, for the handler: the subject the
 *    request resolved to. A refusal of a resolved caller names that caller on
 *    the request row too, so a signed-in user's denial is not filed under
 *    `anonymous`; only an unauthenticated refusal keeps the ingress actor.
 *
 * The kit does NOT know how to turn a `SubjectRef` into an `AuditActor`. The
 * generic half of that mapping lives in `@dads-framework/audit`, which depends on
 * this kit and so cannot be depended on back; the subject kinds themselves are
 * the application's, named in its own access barrels. So the composition root
 * composes the mapping and injects it, and the kit calls what it is handed.
 */

import type { FastifyRequest } from "fastify";

import {
  anonymousActor,
  type AuditActor,
  enterAuditActor,
  runWithAuditActor,
} from "@dads-framework/core/audit-actor";
import type { SubjectRef } from "@dads-framework/access/runtime";

import { rememberRequestActor } from "../request-log/request-outcome.js";
import type { AccessDecision } from "./enforce-access.js";
import { requestIdOf } from "./request-id.js";

/**
 * How a resolved request becomes an actor — what
 * `composeSubjectToAuditActor` from `@dads-framework/audit` produces, and what
 * the composition root passes.
 */
export type AuditActorForSubject = (input: {
  readonly subject: SubjectRef | null;
  readonly authenticatedSubject: SubjectRef | null;
  readonly requestId: string;
}) => AuditActor;

/**
 * Attributes everything this request goes on to do to `anonymous`, from the
 * earliest hook Fastify runs.
 *
 * `enterWith`, not `run`: an `onRequest` hook has to return for the request to
 * continue, so it cannot wrap the handler in a callback. Setting the store on
 * the request's own async context is the mechanism Fastify context plugins use
 * for exactly this reason, and it carries into every later hook, the route
 * handler, the protocol mounts (`/api/auth`, `/scim/v2`), and the error
 * handler.
 */
export function enterAnonymousRequestActor(request: FastifyRequest): void {
  enterAuditActor(anonymousActor(requestIdOf(request)));
}

/**
 * Runs `work` as the subject the request resolved to, keeping the request id
 * the ingress actor already minted so the handler's rows and the request's own
 * row join.
 *
 * Without a mapper the ingress `anonymous` context stands: writes are still
 * attributed and still accepted, just to nobody in particular. That is a
 * deliberately quiet fallback for tests and small embedders — every real app
 * wires the mapper at its composition root.
 */
export function carryResolvedAuditActor<T>(
  auditActorForSubject: AuditActorForSubject | undefined,
  request: FastifyRequest,
  decision: {
    readonly subject: SubjectRef | null;
    readonly authenticatedSubject: SubjectRef | null;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (auditActorForSubject === undefined) return work();
  const actor = auditActorForSubject({
    subject: decision.subject,
    authenticatedSubject: decision.authenticatedSubject,
    requestId: requestIdOf(request),
  });
  // The context below closes when the handler returns, and the request row is
  // built after that. Written down here, the row still knows who this was.
  rememberRequestActor(request, actor);
  return runWithAuditActor(actor, work);
}

/**
 * Names the caller a refusal turned away on the request's own row. Nothing
 * runs after a refusal, so there is no context to enter — only the row to
 * correct. An unauthenticated refusal proved no one and keeps `anonymous`.
 */
export function rememberRefusedAuditActor(
  auditActorForSubject: AuditActorForSubject | undefined,
  request: FastifyRequest,
  refusal: Exclude<AccessDecision, { outcome: "allow" }>,
): void {
  if (auditActorForSubject === undefined) return;
  if (refusal.outcome === "unauthenticated") return;
  rememberRequestActor(
    request,
    auditActorForSubject({
      subject: refusal.subject,
      authenticatedSubject: refusal.authenticatedSubject,
      requestId: requestIdOf(request),
    }),
  );
}
