/**
 * The authorization port, guarded against lists that grow without bound.
 *
 * A list built from "every visible id, then `WHERE id IN (...)`" is fast with
 * ten ids and fails at sixty-five thousand, and nothing in between says so.
 * The entity kind declaration (`scope`, `catalog`, `record`) says which lists
 * may be built that way, but a declaration is only as true as whoever wrote
 * it. So this decorator watches every answer, whatever the declaration says:
 *
 * - **A record is never looked up id by id.** `lookupResources` on a `record`
 *   throws, except for a role the record's scope bindings declare
 *   `sparse-direct` (named by relation, never by caller) and a record with a
 *   dated exception registered at boot. Record lists use `requiresScoped`.
 * - **Warning mark.** A lookup past `warnLookupIds` succeeds and notes a
 *   warning on the request, which the request row records as a fault.
 * - **Hard cap.** A lookup past `maxLookupIds` fails with an error naming the
 *   resource type: a failing list is an incident with a message, a hanging
 *   one is not. The cap sits well below Postgres's 65,535-parameter limit.
 * - **Round-trip budget.** A request whose authorization round trips pass
 *   `warnRoundTrips` notes a warning the same way: an N+1 loop of checks, not
 *   only a large list.
 *
 * Its own decorator rather than part of `TalliedAuthorization`: the tally
 * promises it never changes an outcome, and this one refuses reads. It sits
 * outside the tally (so it reads the round trips the tally just counted) and
 * inside answer-once (so a repeated question is judged once).
 */

import {
  entityKindOf,
  isSparseDirectGrant,
  visibleRecordException,
  type AccessModel,
  type EntityKind,
} from "@dads-framework/access";
import {
  currentRequestWork,
  countAuthorizationLookupSize,
  noteAuthorizationWarning,
} from "@dads-framework/runtime/request-work";

import {
  Authorization,
  checkOutcome,
  type DirectSubjectLookup,
  type PermissionCheckOutcome,
  type PermissionQuery,
  type RelationshipFilter,
  type RelationshipWrite,
  type ResourceLookup,
  type SpiceDbConsistencyToken,
  type SubjectRef,
} from "@dads-framework/access/runtime";

/** The marks, each configurable per deployment. */
export type AuthorizationGuardMarks = {
  /** A lookup returning more ids than this is recorded as a fault. Default 1,000. */
  readonly warnLookupIds: number;
  /** A lookup returning more ids than this fails. Default 10,000. */
  readonly maxLookupIds: number;
  /** A request with more authorization round trips than this is recorded as a fault. Default 50. */
  readonly warnRoundTrips: number;
};

export const DEFAULT_AUTHORIZATION_GUARD_MARKS: AuthorizationGuardMarks = {
  warnLookupIds: 1_000,
  maxLookupIds: 10_000,
  warnRoundTrips: 50,
};

/** Postgres refuses a statement with more bind parameters than this. */
const POSTGRES_PARAMETER_LIMIT = 65_535;

/** Where the guard reads what an entity is; provided by the application. */
export type EntityKindLookup = {
  readonly kindOf: (resourceType: string) => EntityKind | undefined;
  /** Whether a record may still be looked up for this permission or relation. */
  readonly mayLookupRecord: (
    resourceType: string,
    permission: string,
  ) => boolean;
};

/** Apply the composed model's record lookup rules. */
export function authorizationKinds(model: AccessModel): EntityKindLookup {
  return {
    kindOf: (resourceType) => entityKindOf(model, resourceType),
    mayLookupRecord: (resourceType, permission) =>
      isSparseDirectGrant(model, resourceType, permission) ||
      visibleRecordException(model, resourceType) !== undefined,
  };
}

/** A `lookupResources` on a record kind, which record lists must never make. */
export class RecordLookupRefusedError extends Error {
  constructor(query: ResourceLookup) {
    super(
      `lookupResources on ${query.resourceType}#${query.permission} refused: ${query.resourceType} is a record, ` +
        `and a record list must use requiresScoped and declare scope bindings ` +
        `(docs/architecture/authorization.md, "To move a record list onto a scope plan")`,
    );
    this.name = "RecordLookupRefusedError";
  }
}

/** A `lookupResources` that returned more ids than the hard cap allows. */
export class LookupOverHardCapError extends Error {
  constructor(query: ResourceLookup, idCount: number, maxLookupIds: number) {
    super(
      `lookupResources on ${query.resourceType}#${query.permission} for a ${query.subject.type} returned ${idCount} ids, ` +
        `over the ${maxLookupIds} cap (AUTHZ_LOOKUP_MAX_IDS); this list must be filtered by scope, not by every visible id`,
    );
    this.name = "LookupOverHardCapError";
  }
}

export class GuardedAuthorization extends Authorization {
  readonly #inner: Authorization;
  readonly #marks: AuthorizationGuardMarks;
  readonly #kinds: EntityKindLookup;

  constructor(
    inner: Authorization,
    marks: AuthorizationGuardMarks,
    kinds: EntityKindLookup,
  ) {
    super();
    requireSaneMarks(marks);
    this.#inner = inner;
    this.#marks = marks;
    this.#kinds = kinds;
  }

  override async check(query: PermissionQuery): Promise<boolean> {
    const allowed = await this.#inner.check(query);
    this.#watchRoundTrips();
    return allowed;
  }

  override async checkMany(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    if (queries.length === 0) return [];
    const checkMany = this.#inner.checkMany?.bind(this.#inner);
    if (checkMany === undefined) {
      const decisions: boolean[] = [];
      for (const query of queries) decisions.push(await this.check(query));
      return decisions;
    }
    const decisions = await checkMany(queries);
    this.#watchRoundTrips();
    return decisions;
  }

  override async checkEach(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]> {
    if (queries.length === 0) return [];
    const checkEach = this.#inner.checkEach?.bind(this.#inner);
    if (checkEach === undefined) {
      return Promise.all(
        queries.map((query) => checkOutcome(() => this.check(query))),
      );
    }
    const outcomes = await checkEach(queries);
    this.#watchRoundTrips();
    return outcomes;
  }

  override async lookupResources(
    query: ResourceLookup,
  ): Promise<readonly string[]> {
    this.#refuseRecordLookup(query);
    const ids = await this.#inner.lookupResources(query);
    countAuthorizationLookupSize(ids.length);
    if (ids.length > this.#marks.maxLookupIds) {
      throw new LookupOverHardCapError(
        query,
        ids.length,
        this.#marks.maxLookupIds,
      );
    }
    if (ids.length > this.#marks.warnLookupIds) {
      noteAuthorizationWarning({
        type: "AuthorizationLookupOverWarningMark",
        fingerprint: `authz.lookup-size:${query.resourceType}#${query.permission}`,
        detail: `lookupResources on ${query.resourceType}#${query.permission} for a ${query.subject.type} returned ${ids.length} ids, over the ${this.#marks.warnLookupIds} mark (AUTHZ_LOOKUP_WARN_IDS)`,
      });
    }
    this.#watchRoundTrips();
    return ids;
  }

  override async writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    return this.#inner.writeRelationships(writes);
  }

  override async deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken> {
    return this.#inner.deleteRelationships(filter);
  }

  override async relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean> {
    return this.#inner.relationshipExists(filter);
  }

  override async listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
    return this.#inner.listDirectSubjects(query);
  }

  #refuseRecordLookup(query: ResourceLookup): void {
    if (this.#kinds.kindOf(query.resourceType) !== "record") return;
    if (this.#kinds.mayLookupRecord(query.resourceType, query.permission))
      return;
    throw new RecordLookupRefusedError(query);
  }

  /** Read after the inner call, when the tally has counted it. */
  #watchRoundTrips(): void {
    const roundTrips = currentRequestWork()?.authzCheckCount ?? 0;
    if (roundTrips <= this.#marks.warnRoundTrips) return;
    noteAuthorizationWarning({
      type: "AuthorizationRoundTripsOverBudget",
      fingerprint: "authz.round-trips",
      detail: `request made more than ${this.#marks.warnRoundTrips} authorization round trips (AUTHZ_ROUND_TRIPS_WARN)`,
    });
  }
}

function requireSaneMarks(marks: AuthorizationGuardMarks): void {
  const { warnLookupIds, maxLookupIds } = marks;
  for (const [name, value] of Object.entries(marks)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `authorization guard mark ${name} must be a positive integer, got ${value}`,
      );
    }
  }
  if (warnLookupIds >= maxLookupIds) {
    throw new Error(
      `authorization guard warnLookupIds (${warnLookupIds}) must be below maxLookupIds (${maxLookupIds})`,
    );
  }
  if (maxLookupIds >= POSTGRES_PARAMETER_LIMIT) {
    throw new Error(
      `authorization guard maxLookupIds (${maxLookupIds}) must stay below Postgres's ${POSTGRES_PARAMETER_LIMIT}-parameter limit`,
    );
  }
}
