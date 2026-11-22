import type { SubjectRef } from "../runtime/authorization.js";
import { formatRelativeDuration } from "./duration.js";
import type { StoredAccessTuple } from "./in-memory-model-index.js";

/** Active and historical tuples grouped for fast evaluation. */
export type TupleGroups = {
  readonly byResourceRelation: ReadonlyMap<
    string,
    readonly StoredAccessTuple[]
  >;
  readonly allByResourceRelation: ReadonlyMap<
    string,
    readonly StoredAccessTuple[]
  >;
  readonly entitiesByType: ReadonlyMap<string, ReadonlySet<string>>;
};

export type RoleReachResult = {
  readonly matched: boolean;
  readonly witness?: string;
  readonly expiredWitness?: string;
};

export function resourceRelationKey(
  resourceType: string,
  resourceId: string,
  relation: string,
): string {
  return `${resourceType}\0${resourceId}\0${relation}`;
}

export function valuationKey(
  entityType: string,
  resourceId: string,
  permissionName: string,
): string {
  return `${entityType}\0${resourceId}\0${permissionName}`;
}

export function formatTupleLabel(tuple: StoredAccessTuple): string {
  const subjectSuffix =
    tuple.subjectRelation === "" ? "" : `#${tuple.subjectRelation}`;
  const subjectId = tuple.subjectIsWildcard ? "*" : tuple.subjectId;
  return `${tuple.resourceType}:${tuple.resourceId}#${tuple.relation}@${tuple.subjectType}:${subjectId}${subjectSuffix}`;
}

export function isTupleActive(
  tuple: StoredAccessTuple,
  nowMs: number,
): boolean {
  return tuple.expiresAtMs === null || tuple.expiresAtMs > nowMs;
}

function addEntity(
  entitiesByType: Map<string, Set<string>>,
  entityType: string,
  entityId: string,
): void {
  let ids = entitiesByType.get(entityType);
  if (ids === undefined) {
    ids = new Set<string>();
    entitiesByType.set(entityType, ids);
  }
  ids.add(entityId);
}

export function groupTuples(
  tuples: readonly StoredAccessTuple[],
  nowMs: number,
  extraResource?: { readonly type: string; readonly id: string },
): TupleGroups {
  const byResourceRelation = new Map<string, StoredAccessTuple[]>();
  const allByResourceRelation = new Map<string, StoredAccessTuple[]>();
  const entitiesByType = new Map<string, Set<string>>();

  if (extraResource !== undefined) {
    addEntity(entitiesByType, extraResource.type, extraResource.id);
  }

  for (const tuple of tuples) {
    const groupKey = resourceRelationKey(
      tuple.resourceType,
      tuple.resourceId,
      tuple.relation,
    );
    const allList = allByResourceRelation.get(groupKey) ?? [];
    allList.push(tuple);
    allByResourceRelation.set(groupKey, allList);

    if (!isTupleActive(tuple, nowMs)) continue;
    const activeList = byResourceRelation.get(groupKey) ?? [];
    activeList.push(tuple);
    byResourceRelation.set(groupKey, activeList);

    addEntity(entitiesByType, tuple.resourceType, tuple.resourceId);
    if (!tuple.subjectIsWildcard) {
      addEntity(entitiesByType, tuple.subjectType, tuple.subjectId);
    }
  }

  return { byResourceRelation, allByResourceRelation, entitiesByType };
}

function matchesActorDirectly(
  tuple: StoredAccessTuple,
  actor: SubjectRef,
): boolean {
  if (actor.relation !== undefined) {
    return (
      tuple.subjectType === actor.type &&
      tuple.subjectId === actor.id &&
      tuple.subjectRelation === actor.relation
    );
  }
  if (tuple.subjectRelation !== "") return false;
  if (tuple.subjectType !== actor.type) return false;
  return tuple.subjectIsWildcard || tuple.subjectId === actor.id;
}

function findExpiredWitness(
  groups: TupleGroups,
  nodeKey: string,
  actor: SubjectRef,
  nowMs: number,
): string | undefined {
  const allTuples = groups.allByResourceRelation.get(nodeKey) ?? [];
  for (const tuple of allTuples) {
    if (isTupleActive(tuple, nowMs)) continue;
    if (!matchesActorDirectly(tuple, actor)) continue;
    const expiredAgo = formatRelativeDuration(
      nowMs - (tuple.expiresAtMs ?? nowMs),
    );
    return `expired ${expiredAgo} ago: ${formatTupleLabel(tuple)}`;
  }
  return undefined;
}

export function checkRoleReachability(
  groups: TupleGroups,
  resourceType: string,
  resourceId: string,
  relation: string,
  actor: SubjectRef,
  nowMs: number,
  visited: Set<string>,
): RoleReachResult {
  const nodeKey = resourceRelationKey(resourceType, resourceId, relation);
  if (visited.has(nodeKey)) return { matched: false };
  visited.add(nodeKey);

  const activeTuples = groups.byResourceRelation.get(nodeKey) ?? [];
  for (const tuple of activeTuples) {
    if (matchesActorDirectly(tuple, actor)) {
      return { matched: true, witness: formatTupleLabel(tuple) };
    }
  }

  for (const tuple of activeTuples) {
    if (tuple.subjectRelation === "") continue;
    const nested = checkRoleReachability(
      groups,
      tuple.subjectType,
      tuple.subjectId,
      tuple.subjectRelation,
      actor,
      nowMs,
      visited,
    );
    if (nested.matched) {
      const chain =
        nested.witness === undefined
          ? formatTupleLabel(tuple)
          : `${formatTupleLabel(tuple)} -> ${nested.witness}`;
      return { matched: true, witness: chain };
    }
  }

  const expiredWitness = findExpiredWitness(groups, nodeKey, actor, nowMs);
  return expiredWitness === undefined
    ? { matched: false }
    : { matched: false, expiredWitness };
}

export function activeRoleTargets(
  groups: TupleGroups,
  resourceType: string,
  resourceId: string,
  roleName: string,
): readonly StoredAccessTuple[] {
  const key = resourceRelationKey(resourceType, resourceId, roleName);
  const active = groups.byResourceRelation.get(key) ?? [];
  return active.filter(
    (tuple) => tuple.subjectRelation === "" && !tuple.subjectIsWildcard,
  );
}
