/**
 * The authorization seam (docs/architecture/authorization.md): every access
 * decision in the system goes through this port. SpiceDB is an adapter
 * behind it; nothing outside the adapter imports the SpiceDB client.
 *
 * Failed checks surface to callers as 404s — don't leak existence
 * (docs/architecture/api-conventions.md#errors).
 */

/** Maps `user:abc123` to an explicit subject type and identifier. */
export type SubjectRef = {
  type: string;
  id: string;
  /** subject-set relation, e.g. organization#member as a subject */
  relation?: string;
};

/** String identifiers passed to the authorization adapter. */
export type WireResourceRef = {
  /** namespaced object type, e.g. "organizations/organization" */
  type: string;
  id: string;
};

export type { WireResourceRef as ResourceRef };

export type PermissionQuery = {
  subject: SubjectRef;
  /** permission (verb), never a relation (noun) */
  permission: string;
  resource: WireResourceRef;
  /**
   * Preserved for read-your-writes callers. Enforcement never reads older
   * than the server's own newest write, with or without this token.
   */
  consistencyToken?: SpiceDbConsistencyToken;
  /**
   * `fully-consistent` reads past every cache, so a grant another API
   * instance projected after this process's own newest write is seen. For a
   * refusal that must be final before acting on it; it costs a full read.
   */
  consistency?: "fully-consistent";
};

export type ResourceLookup = {
  subject: SubjectRef;
  permission: string;
  resourceType: string;
  /**
   * Preserved for read-your-writes callers. Discovery never reads older than
   * the server's own newest write; an old token cannot retain resources
   * revoked by another request.
   */
  consistencyToken?: SpiceDbConsistencyToken;
};

export type RelationshipWrite = {
  resource: WireResourceRef;
  /** relation (noun), e.g. "owner", "admin" */
  relation: string;
  subject: SubjectRef;
};

export type RelationshipFilter = {
  resourceType: string;
  resourceId?: string;
  relation?: string;
  /**
   * When set, only delete tuples for this subject (SpiceDB optionalSubjectFilter).
   * Pass `id: ""` to match every subject of `type` (type-wide subject filter).
   */
  subject?: SubjectRef;
};

/**
 * List subjects that hold a **direct** relation on a resource (ReadRelationships).
 * Membership / people UIs use this — not permission LookupSubjects — so inherited
 * administrators who inherit access do not appear as direct members.
 */
export type DirectSubjectLookup = {
  resource: WireResourceRef;
  relation: string;
  /**
   * Override the adapter's ordinary read posture for a correctness-critical
   * direct-subject decision. Omit for the configured default used by display
   * lists; last-holder guards require a current roster.
   */
  consistency?: "fully-consistent";
  consistencyToken?: SpiceDbConsistencyToken;
};

/**
 * One question's outcome from `checkEach`: the decision, or the error the
 * vendor reported for that question alone.
 */
export type PermissionCheckOutcome =
  | { readonly kind: "answered"; readonly allowed: boolean }
  | { readonly kind: "failed"; readonly error: Error };

/** Opaque consistency token — pass back for read-your-writes flows. */
export type SpiceDbConsistencyToken = string;

/**
 * Abstract class on purpose: it is both the TypeScript interface and the
 * wiring seam. Implemented by SpiceDbAuthorization; constructed by
 * createSpiceDbAuthorization in the composition root; FakeAuthorization for unit tests.
 */
export abstract class Authorization {
  /** Enforcement decision; a completed revocation the server wrote cannot read stale. */
  abstract check(query: PermissionQuery): Promise<boolean>;
  /** Decisions in input order, as fresh as `check`; item errors deny and batch failures propagate. */
  checkMany?(queries: readonly PermissionQuery[]): Promise<readonly boolean[]>;
  /**
   * Outcomes in input order from one bulk call, as fresh as `check`. An item
   * error is that item's `failed` outcome, never a deny; a batch failure
   * propagates. How concurrent single checks share one round trip.
   */
  checkEach?(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]>;
  /** Authorized collection; never a union from before a revocation the server wrote. */
  abstract lookupResources(query: ResourceLookup): Promise<readonly string[]>;
  abstract writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken>;
  abstract deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken>;
  /**
   * True when at least one subject holds `relation` on the resource —
   * used by ownership reconciliation (row without parent tuple).
   */
  abstract relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean>;
  /**
   * Subjects with a direct `relation` tuple on `resource` — for grant lists.
   */
  abstract listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]>;
}

/**
 * One plain check as a `checkEach` outcome: what a decorator answers per item
 * when the port behind it has no bulk `checkEach`.
 */
export async function checkOutcome(
  check: () => Promise<boolean>,
): Promise<PermissionCheckOutcome> {
  try {
    return { kind: "answered", allowed: await check() };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Helper for tuple literals: relationshipWrite(resource, relation, subject). */
export function relationshipWrite(
  resource: WireResourceRef,
  relation: string,
  subject: SubjectRef,
): RelationshipWrite {
  return { resource, relation, subject };
}
