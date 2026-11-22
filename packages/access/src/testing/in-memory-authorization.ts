import type { AccessModel } from "../core/access-model.js";
import {
  Authorization,
  type DirectSubjectLookup,
  type PermissionCheckOutcome,
  type PermissionQuery,
  type RelationshipFilter,
  type RelationshipWrite,
  type ResourceLookup,
  type SpiceDbConsistencyToken,
  type SubjectLookup,
  type SubjectLookupResult,
  type SubjectRef,
} from "../runtime/authorization.js";
import { ControllableClock, type TestDuration } from "./duration.js";
import {
  formatPermissionExplanation,
  type PermissionExplanation,
} from "./explain-format.js";
import {
  computeActorValuation,
  evaluateLookupResources,
  isTupleActive,
  valuationKey,
} from "./in-memory-evaluator.js";
import { explainPermissionQuery } from "./in-memory-explainer.js";
import {
  indexAccessModel,
  type IndexedAccessModel,
  type StoredAccessTuple,
  tupleStorageKey,
} from "./in-memory-model-index.js";

export type InMemoryAuthorizationOptions = {
  readonly clock?: ControllableClock;
  readonly now?: () => Date;
  readonly startTime?: Date | number;
};

function toStoredTuple(write: RelationshipWrite): StoredAccessTuple {
  const isWildcard =
    write.subject.id === "*" && write.subject.relation === undefined;
  return {
    resourceType: write.resource.type,
    resourceId: write.resource.id,
    relation: write.relation,
    subjectType: write.subject.type,
    subjectId: isWildcard ? "*" : write.subject.id,
    subjectRelation: write.subject.relation ?? "",
    subjectIsWildcard: isWildcard,
    expiresAtMs:
      write.expiresAt === undefined ? null : write.expiresAt.getTime(),
  };
}

function matchesSubjectFilter(
  tuple: StoredAccessTuple,
  filterSubject: SubjectRef,
): boolean {
  if (tuple.subjectType !== filterSubject.type) return false;
  if (filterSubject.id !== "" && tuple.subjectId !== filterSubject.id) {
    return false;
  }
  if (
    filterSubject.relation !== undefined &&
    tuple.subjectRelation !== filterSubject.relation
  ) {
    return false;
  }
  return true;
}

function matchesDeleteFilter(
  tuple: StoredAccessTuple,
  filter: RelationshipFilter,
): boolean {
  if (tuple.resourceType !== filter.resourceType) return false;
  if (
    filter.resourceId !== undefined &&
    tuple.resourceId !== filter.resourceId
  ) {
    return false;
  }
  if (filter.relation !== undefined && tuple.relation !== filter.relation) {
    return false;
  }
  if (
    filter.subject !== undefined &&
    !matchesSubjectFilter(tuple, filter.subject)
  ) {
    return false;
  }
  return true;
}

function actorCacheKey(subject: SubjectRef): string {
  return `${subject.type}\0${subject.id}\0${subject.relation ?? ""}`;
}

/**
 * Pure TypeScript in-memory authorization engine backed by a compiled `AccessModel`.
 * Evaluates full ReBAC semantics (arrows, recursive graphs, cycles, usersets,
 * wildcards, `allOf`, `anyOf`, `every`, `unless`, and expiration) with zero I/O.
 */
export class InMemoryAuthorization extends Authorization {
  private readonly index: IndexedAccessModel;
  private readonly tuples = new Map<string, StoredAccessTuple>();
  private readonly clock: ControllableClock;
  private readonly readNow: () => Date;
  private revision = 0;

  constructor(model: AccessModel, options?: InMemoryAuthorizationOptions) {
    super();
    this.index = indexAccessModel(model);
    this.clock = options?.clock ?? new ControllableClock(options?.startTime);
    this.readNow = options?.now ?? (() => this.clock.now());
  }

  now(): Date {
    return this.readNow();
  }

  advanceTime(duration: TestDuration): Date {
    return this.clock.advance(duration);
  }

  setTime(nextTime: Date | number): Date {
    return this.clock.set(nextTime);
  }

  getClock(): ControllableClock {
    return this.clock;
  }

  listStoredTuples(): readonly StoredAccessTuple[] {
    return [...this.tuples.values()];
  }

  writeRelationshipsSync(
    writes: readonly RelationshipWrite[],
  ): SpiceDbConsistencyToken {
    for (const write of writes) {
      const stored = toStoredTuple(write);
      this.tuples.set(tupleStorageKey(stored), stored);
    }
    this.revision += 1;
    return `memory-rev-${String(this.revision)}`;
  }

  deleteRelationshipsSync(filter: RelationshipFilter): SpiceDbConsistencyToken {
    for (const [key, tuple] of [...this.tuples.entries()]) {
      if (matchesDeleteFilter(tuple, filter)) {
        this.tuples.delete(key);
      }
    }
    this.revision += 1;
    return `memory-rev-${String(this.revision)}`;
  }

  checkSync(query: PermissionQuery): boolean {
    if (
      this.index.permissionsByEntity
        .get(query.resource.type)
        ?.has(query.permission) !== true
    ) {
      return false;
    }
    const { valuation } = computeActorValuation(
      this.index,
      [...this.tuples.values()],
      query.subject,
      this.readNow().getTime(),
      query.resource,
    );
    return (
      valuation.get(
        valuationKey(query.resource.type, query.resource.id, query.permission),
      ) === true
    );
  }

  checkManySync(queries: readonly PermissionQuery[]): readonly boolean[] {
    if (queries.length === 0) return [];
    const nowMs = this.readNow().getTime();
    const tupleList = [...this.tuples.values()];
    const valuationCache = new Map<string, ReadonlyMap<string, boolean>>();

    return queries.map((query) => {
      if (
        this.index.permissionsByEntity
          .get(query.resource.type)
          ?.has(query.permission) !== true
      ) {
        return false;
      }
      const cacheKey = actorCacheKey(query.subject);
      let valuation = valuationCache.get(cacheKey);
      if (valuation === undefined) {
        valuation = computeActorValuation(
          this.index,
          tupleList,
          query.subject,
          nowMs,
        ).valuation;
        valuationCache.set(cacheKey, valuation);
      }
      return (
        valuation.get(
          valuationKey(
            query.resource.type,
            query.resource.id,
            query.permission,
          ),
        ) === true
      );
    });
  }

  lookupResourcesSync(query: ResourceLookup): readonly string[] {
    return evaluateLookupResources(
      this.index,
      [...this.tuples.values()],
      query.subject,
      query.resourceType,
      query.permission,
      this.readNow().getTime(),
    );
  }

  lookupSubjectsSync(query: SubjectLookup): SubjectLookupResult {
    const nowMs = this.readNow().getTime();
    const candidateIds = new Set<string>();
    for (const tuple of this.tuples.values()) {
      if (!isTupleActive(tuple, nowMs)) continue;
      if (tuple.subjectType === query.subjectType && !tuple.subjectIsWildcard) {
        candidateIds.add(tuple.subjectId);
      }
    }
    const probeId = "__dads_wildcard_probe__";
    const hasWildcard = this.checkSync({
      subject: { type: query.subjectType, id: probeId },
      resource: query.resource,
      permission: query.permission,
    });
    const subjects: string[] = [];
    for (const candidateId of candidateIds) {
      const allowed = this.checkSync({
        subject: { type: query.subjectType, id: candidateId },
        resource: query.resource,
        permission: query.permission,
      });
      if (allowed) subjects.push(candidateId);
    }
    return { subjects: subjects.sort(), hasWildcard };
  }

  explain(query: PermissionQuery): PermissionExplanation {
    return explainPermissionQuery(
      this.index,
      [...this.tuples.values()],
      query,
      this.readNow().getTime(),
    );
  }

  explainText(query: PermissionQuery): string {
    return formatPermissionExplanation(query, this.explain(query));
  }

  override check(query: PermissionQuery): Promise<boolean> {
    return Promise.resolve(this.checkSync(query));
  }

  override checkMany(
    queries: readonly PermissionQuery[],
  ): Promise<readonly boolean[]> {
    return Promise.resolve(this.checkManySync(queries));
  }

  override checkEach(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionCheckOutcome[]> {
    return Promise.resolve(
      this.checkManySync(queries).map((allowed) => ({
        kind: "answered",
        allowed,
      })),
    );
  }

  override lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    return Promise.resolve(this.lookupResourcesSync(query));
  }

  override lookupSubjects(query: SubjectLookup): Promise<SubjectLookupResult> {
    return Promise.resolve(this.lookupSubjectsSync(query));
  }

  override writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    return Promise.resolve(this.writeRelationshipsSync(writes));
  }

  override deleteRelationships(
    filter: RelationshipFilter,
  ): Promise<SpiceDbConsistencyToken> {
    return Promise.resolve(this.deleteRelationshipsSync(filter));
  }

  override relationshipExists(filter: {
    resourceType: string;
    resourceId: string;
    relation: string;
  }): Promise<boolean> {
    const nowMs = this.readNow().getTime();
    for (const tuple of this.tuples.values()) {
      if (!isTupleActive(tuple, nowMs)) continue;
      if (
        tuple.resourceType === filter.resourceType &&
        tuple.resourceId === filter.resourceId &&
        tuple.relation === filter.relation
      ) {
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  override listDirectSubjects(
    query: DirectSubjectLookup,
  ): Promise<readonly SubjectRef[]> {
    const nowMs = this.readNow().getTime();
    const subjects: SubjectRef[] = [];
    for (const tuple of this.tuples.values()) {
      if (!isTupleActive(tuple, nowMs)) continue;
      if (
        tuple.resourceType !== query.resource.type ||
        tuple.resourceId !== query.resource.id ||
        tuple.relation !== query.relation
      ) {
        continue;
      }
      subjects.push({
        type: tuple.subjectType,
        id: tuple.subjectIsWildcard ? "*" : tuple.subjectId,
        ...(tuple.subjectRelation === ""
          ? {}
          : { relation: tuple.subjectRelation }),
      });
    }
    return Promise.resolve(subjects);
  }
}
