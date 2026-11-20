import type {
  Authorization,
  RelationshipFilter,
  RelationshipWrite,
} from "@dads-framework/access/runtime";
import type { EnqueueAccessChanges } from "./enqueue.js";
import { outboxKeyForRelationship, type AccessChange } from "./enqueue.js";

/**
 * Write-through revocation: remove access NOW, and record the removal so it
 * cannot be lost.
 *
 * ## Grants and revocations are deliberately asymmetric — do not simplify this
 *
 * It is tempting to notice that this file and the create path both produce
 * outbox rows, and to "unify" them into one enqueue-and-let-the-projector-do-it
 * shape. That would be a security regression, and the asymmetry is the whole
 * reason this helper exists (commitment 2).
 *
 * A **grant** may wait for the projector. Until the tuple lands nobody can
 * reach the resource, so a late grant is a closed door — a slow UI.
 *
 * A **revocation** may not wait. Until the tuple is gone somebody still has
 * access they are no longer entitled to, so a queue between the decision and
 * the removal is a window of lingering access — a security incident. The
 * synchronous `deleteRelationships` is therefore not an optimization that a
 * later refactor may drop; it is the property.
 *
 * ## The synchronous delete is best-effort, and the operation still succeeds
 *
 * The outbox row is committed FIRST, either by `revokeAccess` for a rowless
 * revocation or by the lifecycle writer's own transaction. Only then does the
 * synchronous removal run. If the graph is unreachable and removal throws,
 * the synchronous helper swallows the error and returns normally, because by
 * then the durable record exists and the projector will retry until the tuple
 * is gone. Failing the caller would report failure for a guaranteed removal.
 *
 * The order matters in the other direction too: if the enqueue itself fails
 * this function throws and nothing has been removed, so the caller's operation
 * fails with the world unchanged rather than half-revoked.
 *
 * ## Why neither public helper accepts a transaction handle
 *
 * A lifecycle writer enqueues inside its own transaction so the row, event and
 * DELETE fact commit together, then passes only the committed relationship and
 * cause to `deleteRelationshipsNow`. A rowless revocation
 * has no transaction to join, so `revokeAccess` owns the append before using
 * the same synchronous helper. Mutations receive neither a database handle nor
 * an outbox seam for lifecycle-backed revocation.
 */
export type RevokeThroughInput = {
  readonly authorization: Authorization;
  readonly outbox: EnqueueAccessChanges;
  /**
   * The tuples being removed, each fully specified. An outbox row names one
   * resource, relation and subject, so "every tuple on this resource" cannot
   * be expressed as a row — name the ones you know here and use `sweep` for
   * the rest.
   */
  readonly relationships: readonly RelationshipWrite[];
  /**
   * The id of the state change that caused this revocation — the deleted row,
   * the ended session, the membership that moved. Makes the idempotency key
   * stable across retries of the same logical change (see
   * `outboxKeyForRelationship`).
   */
  readonly cause: string;
  /** The authority partition these facts belong to. */
  readonly ownerPartitionId?: string | null;
  /**
   * What the synchronous removal actually deletes. Defaults to exactly the
   * relationships above. Deleting an entire resource may instead need a broad filter
   * that removes every tuple on it, including
   * grants this code never enumerated — those cannot become outbox rows, so
   * the synchronous sweep is the only thing that removes them.
   */
  readonly sweep?: readonly RelationshipFilter[];
  /**
   * Told when the synchronous removal fails. Optional so a unit test need not
   * supply one, but production callers should: this is the ONE path where
   * access outlives the decision to remove it, and swallowing it silently
   * would make the security-relevant case the invisible one. The revocation is
   * still guaranteed by the committed row — the log is how anyone finds out
   * the graph is behind.
   */
  readonly log?: RevocationLog;
};

/**
 * The narrow logging surface a revocation needs, declared here rather than
 * imported so this battery does not acquire an observability dependency for
 * one call.
 */
export type RevocationLog = { warn(obj: object, msg?: string): void };

export type CommittedSynchronousRevocationInput = {
  readonly authorization: Authorization;
  readonly relationships: readonly RelationshipWrite[];
  readonly committedFactCause: string;
  readonly sweep?: readonly RelationshipFilter[];
  readonly log?: RevocationLog;
};

/**
 * Best-effort graph removal for a caller that MUST already have co-committed
 * exact DELETE facts using `committedFactCause`. This function never records
 * durability.
 */
export async function deleteRelationshipsNow(
  input: CommittedSynchronousRevocationInput,
): Promise<void> {
  const filters = input.sweep ?? input.relationships.map(toFilter);
  for (const filter of filters) {
    try {
      await input.authorization.deleteRelationships(filter);
    } catch (error) {
      input.log?.warn(
        {
          error: String(error),
          resourceType: filter.resourceType,
          resourceId: filter.resourceId,
          relation: filter.relation,
          cause: input.committedFactCause,
        },
        "synchronous revocation failed; access persists until the outbox row is projected",
      );
    }
  }
}

export async function revokeAccess(input: RevokeThroughInput): Promise<void> {
  const entries: AccessChange[] = input.relationships.map((relationship) => ({
    idempotencyKey: outboxKeyForRelationship(
      "DELETE",
      relationship,
      input.cause,
    ),
    operation: "DELETE",
    relationship,
    ownerPartitionId: input.ownerPartitionId ?? null,
  }));

  await input.outbox.append(entries);

  await deleteRelationshipsNow({
    authorization: input.authorization,
    relationships: input.relationships,
    committedFactCause: input.cause,
    ...(input.sweep === undefined ? {} : { sweep: input.sweep }),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
}

function toFilter(relationship: RelationshipWrite): RelationshipFilter {
  return {
    resourceType: relationship.resource.type,
    resourceId: relationship.resource.id,
    relation: relationship.relation,
    subject: relationship.subject,
  };
}
