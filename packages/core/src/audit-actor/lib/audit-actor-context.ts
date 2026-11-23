/**
 * The actor context: the ONLY way an actor reaches the database.
 *
 * No writer takes an actor argument and no call site passes one. The postgres
 * kit's attributed pool reads `currentAuditActor()` on every connection
 * checkout and stamps it into `dads.audit_actor` before the caller's first
 * statement, so attribution follows the async task rather than the call graph.
 * A write that runs outside any context reaches the `audit_record` trigger
 * unattributed and is refused — forgetting a context fails loudly instead of
 * quietly losing who did it.
 *
 * A context is established at three seams and nowhere else:
 *
 * - the HTTP request (anonymous at ingress, re-entered with the resolved
 *   subject after access enforcement);
 * - the job runner, as `system:job:<name>`;
 * - scripts, migrations, seeds, and tests, as `system:<name>`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mintUuidV7 } from "../../contract/index.js";
import type { AuditActor } from "./audit-actor.js";

const auditActorContext = new AsyncLocalStorage<AuditActor>();

/**
 * Runs `work` with `actor` attributed to every database write it makes,
 * including writes made by anything it awaits. Contexts nest: the inner actor
 * wins for the duration and the outer one is restored on the way out.
 */
export async function runWithAuditActor<T>(
  actor: AuditActor,
  work: () => Promise<T> | T,
): Promise<T> {
  return auditActorContext.run(actor, async () => work());
}

/**
 * Establishes `actor` for the rest of the CURRENT async task, with no callback
 * to come back out of.
 *
 * `runWithAuditActor` is the form to reach for; this one exists for the single
 * place a callback cannot span the boundary. Fastify runs a request as a chain
 * of separate hook callbacks (`onRequest` → … → handler → `onResponse`), so
 * nothing at ingress can wrap what comes after it — the hook has to return.
 * `enterWith` sets the store on the request's own async context instead, and
 * every continuation scheduled from it inherits the actor.
 *
 * The context is never "left": the next request's ingress overwrites it before
 * that request can write anything, which is the same discipline the attributed
 * pool applies at checkout.
 */
export function enterAuditActor(actor: AuditActor): void {
  auditActorContext.enterWith(actor);
}

/**
 * The actor attributed to the current async task, or `undefined` outside any
 * context. The attributed pool calls this on every checkout.
 */
export function currentAuditActor(): AuditActor | undefined {
  return auditActorContext.getStore();
}

/**
 * Re-enters the current context with a reason attached, for a mutation that
 * wants to annotate why it changed what it changed. Kind, id, and request id
 * are the ones already in force, so a reason can never invent an actor.
 *
 * Outside any context there is nothing to annotate, so `work` runs unchanged
 * and its writes are refused by the trigger exactly as they would have been.
 */
export async function withReason<T>(
  reason: string,
  work: () => Promise<T> | T,
): Promise<T> {
  const actor = currentAuditActor();
  if (actor === undefined) return work();
  return runWithAuditActor({ ...actor, reason }, work);
}

/**
 * The actor for work no human asked for: `migration`, `seed`, `bootstrap`,
 * `test`, or `job:<name>`. Each run mints its own request id when one is not
 * supplied, so the rows a single run wrote can be found together.
 */
export function systemActor(name: string, requestId?: string): AuditActor {
  return { kind: "system", id: name, requestId: requestId ?? mintUuidV7() };
}

/** Runs `work` attributed to the named system actor. */
export async function withSystemActor<T>(
  name: string,
  work: () => Promise<T> | T,
  requestId?: string,
): Promise<T> {
  return runWithAuditActor(systemActor(name, requestId), work);
}

/**
 * The actor for a request that has no resolved subject yet — login and the
 * other protocol-mount flows that legitimately write before authentication.
 * The request id is what ties those rows to the request row that holds the
 * address and user agent.
 */
export function anonymousActor(requestId: string): AuditActor {
  return { kind: "anonymous", id: "", requestId };
}
