/**
 * The authorization port, counted.
 *
 * Every enforcement check SpiceDB answers is one gRPC round trip, and a list
 * endpoint that checks once per row pays for every one of them — the N+1
 * this system is most prone to. Counted here so `request_log` shows it,
 * whatever adapter composition supplies (the fake included, which lets a
 * unit test assert a budget without a running SpiceDB).
 *
 * A bulk permission check costs one call; individual fallback checks each
 * cost one. Writes remain the mutation's own cost. Every method still
 * forwards, so behaviour is unchanged in every case.
 */

import { chargeAuthorizationCheck } from "@dads-framework/runtime/request-work";

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

export class TalliedAuthorization extends Authorization {
  readonly #inner: Authorization;

  constructor(inner: Authorization) {
    super();
    this.#inner = inner;
  }

  override async check(query: PermissionQuery): Promise<boolean> {
    return chargeAuthorizationCheck(async () => this.#inner.check(query));
  }

  override async checkMany(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    if (queries.length === 0) return [];
    const checkMany = this.#inner.checkMany?.bind(this.#inner);
    if (checkMany !== undefined) {
      return chargeAuthorizationCheck(async () => checkMany(queries));
    }
    const decisions: boolean[] = [];
    for (const query of queries) decisions.push(await this.check(query));
    return decisions;
  }

  override async checkEach(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]> {
    if (queries.length === 0) return [];
    const checkEach = this.#inner.checkEach?.bind(this.#inner);
    if (checkEach !== undefined) {
      return chargeAuthorizationCheck(async () => checkEach(queries));
    }
    return Promise.all(
      queries.map((query) => checkOutcome(() => this.check(query))),
    );
  }

  override async lookupResources(
    query: ResourceLookup,
  ): Promise<readonly string[]> {
    return chargeAuthorizationCheck(async () =>
      this.#inner.lookupResources(query),
    );
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
}
