/**
 * Turns the authorization subject a request resolved into the actor the audit
 * trail records. Pure: no I/O, no clock, no database.
 *
 * What every product shares lives here: the plain user mapping, the fail-safe
 * for a subject kind this build does not recognize, and the `subject === null`
 * path. Which OTHER subject kinds exist is a product's own knowledge — the
 * wire names come from its access barrels — so a product composes its mapper
 * from handlers keyed by those names instead of this kit importing them.
 */

import type { AuditActor } from "@dads-framework/core/audit-actor";
import type { SubjectRef } from "@dads-framework/spicedb-access";
import type { AuditActorForSubject } from "@dads-framework/http";

/** The `SubjectRef.type` of an ordinary human account. */
export const USER_SUBJECT_TYPE = "user";

/** What every mapping needs: the subject, who proved it, and the request. */
export type ResolvedSubject = {
  readonly subject: SubjectRef;
  /** The identity the credential proved, before any business actor swap. */
  readonly authenticatedSubject: SubjectRef | null;
  readonly requestId: string;
};

/** How one subject kind becomes the actor its writes are recorded under. */
export type ActorForSubject = (resolved: ResolvedSubject) => AuditActor;

/**
 * Builds the mapping the HTTP kit calls, from one handler per subject kind the
 * product knows, keyed by the wire name its access barrel defines. The plain
 * `user` mapping is this kit's and is not replaceable; a type the table does
 * not name takes the fail-safe below.
 */
export function composeSubjectToAuditActor(
  actorForSubjectType: Readonly<Record<string, ActorForSubject>>,
  actorForRequest?: (input: Parameters<AuditActorForSubject>[0]) => AuditActor | undefined,
): AuditActorForSubject {
  const actorForType = new Map<string, ActorForSubject>([
    ...Object.entries(actorForSubjectType),
    [USER_SUBJECT_TYPE, userActor],
  ]);

  return (request) => {
    const override = actorForRequest?.(request);
    if (override !== undefined) return override;
    const { subject, authenticatedSubject, requestId } = request;
    if (subject === null) {
      return provenIdentityActor({ authenticatedSubject, requestId });
    }

    const actorFor = actorForType.get(subject.type);
    const resolved = { subject, authenticatedSubject, requestId };
    return actorFor === undefined ? provenIdentityActor(resolved) : actorFor(resolved);
  };
}

/**
 * A plain user, but only when the credential proved that same user. Any
 * disagreement between the two falls back to the identity actually proven.
 */
function userActor(resolved: ResolvedSubject): AuditActor {
  const { subject, authenticatedSubject, requestId } = resolved;
  const provenSameUser = authenticatedSubject?.type === USER_SUBJECT_TYPE && subject.id === authenticatedSubject.id;
  return provenSameUser ? { kind: "user", id: subject.id, requestId } : provenIdentityActor(resolved);
}

/**
 * Fail-safe. A subject type this build does not recognize — a new actor kind
 * landing before the product's table learns it, or the two subjects
 * disagreeing — still has to produce an actor, because returning nothing would
 * make the trigger refuse a write that was properly authenticated. Attribute
 * it to the identity the credential actually proved, and to `anonymous` only
 * when no credential proved one.
 */
function provenIdentityActor(proof: {
  readonly authenticatedSubject: SubjectRef | null;
  readonly requestId: string;
}): AuditActor {
  const { authenticatedSubject, requestId } = proof;
  if (authenticatedSubject?.type === USER_SUBJECT_TYPE) {
    return { kind: "user", id: authenticatedSubject.id, requestId };
  }
  return { kind: "anonymous", id: "", requestId };
}
