import type { AccessIrTerm } from "../core/ir.js";
import type { SubjectRef } from "../runtime/authorization.js";
import type { IndexedAccessModel, StoredAccessTuple } from "./in-memory-model-index.js";
import {
  activeRoleTargets,
  checkRoleReachability,
  groupTuples,
  isTupleActive,
  type TupleGroups,
  valuationKey,
} from "./in-memory-reachability.js";

export { activeRoleTargets, checkRoleReachability, isTupleActive, type TupleGroups, valuationKey };

export function lookupTargetAccess(
  index: IndexedAccessModel,
  groups: TupleGroups,
  valuation: ReadonlyMap<string, boolean>,
  targetType: string,
  targetId: string,
  targetPermission: string,
  actor: SubjectRef,
  nowMs: number,
): boolean {
  const entityPermissions = index.permissionsByEntity.get(targetType);
  if (entityPermissions?.has(targetPermission) === true) {
    return valuation.get(valuationKey(targetType, targetId, targetPermission)) === true;
  }
  return checkRoleReachability(groups, targetType, targetId, targetPermission, actor, nowMs, new Set()).matched;
}

type EvalContext = {
  readonly index: IndexedAccessModel;
  readonly groups: TupleGroups;
  readonly valuation: ReadonlyMap<string, boolean>;
  readonly entityType: string;
  readonly resourceId: string;
  readonly actor: SubjectRef;
  readonly nowMs: number;
};

function evaluateThroughTerm(
  context: EvalContext,
  roleName: string,
  targetPermission: string,
  requireAll: boolean,
): boolean {
  const targets = activeRoleTargets(context.groups, context.entityType, context.resourceId, roleName);
  if (requireAll && targets.length === 0) return false;
  const checkTarget = (target: StoredAccessTuple) =>
    lookupTargetAccess(
      context.index,
      context.groups,
      context.valuation,
      target.subjectType,
      target.subjectId,
      targetPermission,
      context.actor,
      context.nowMs,
    );
  return requireAll ? targets.every(checkTarget) : targets.some(checkTarget);
}

function evaluateCompoundTerm(
  context: EvalContext,
  term: Extract<AccessIrTerm, { readonly kind: "gated" | "both" | "excluding" | "or" }>,
): boolean {
  if (term.kind === "gated") {
    return evaluateTermValue(context, term.term) && evaluateTermValue(context, term.condition);
  }
  if (term.kind === "both") {
    return evaluateTermValue(context, term.left) && evaluateTermValue(context, term.right);
  }
  if (term.kind === "excluding") {
    return evaluateTermValue(context, term.term) && !evaluateTermValue(context, term.banned);
  }
  return term.terms.some((branch) => evaluateTermValue(context, branch));
}

function evaluateTermValue(context: EvalContext, term: AccessIrTerm): boolean {
  if (term.kind === "role") {
    return checkRoleReachability(
      context.groups,
      context.entityType,
      context.resourceId,
      term.name,
      context.actor,
      context.nowMs,
      new Set(),
    ).matched;
  }
  if (term.kind === "permission") {
    return context.valuation.get(valuationKey(context.entityType, context.resourceId, term.name)) === true;
  }
  if (term.kind === "through" || term.kind === "through-all") {
    return evaluateThroughTerm(context, term.roleName, term.targetPermission, term.kind === "through-all");
  }
  return evaluateCompoundTerm(context, term);
}

function stepResourcePermissions(
  context: EvalContext,
  permissions: readonly {
    readonly name: string;
    readonly terms: readonly AccessIrTerm[];
  }[],
  current: ReadonlyMap<string, boolean>,
  next: Map<string, boolean>,
): boolean {
  let changed = false;
  for (const permission of permissions) {
    const allowed = permission.terms.some((term) => evaluateTermValue(context, term));
    const key = valuationKey(context.entityType, context.resourceId, permission.name);
    if ((current.get(key) ?? false) !== allowed) changed = true;
    if (allowed) next.set(key, true);
  }
  return changed;
}

function stepValuation(
  index: IndexedAccessModel,
  groups: TupleGroups,
  current: ReadonlyMap<string, boolean>,
  actor: SubjectRef,
  nowMs: number,
): { readonly next: Map<string, boolean>; readonly changed: boolean } {
  const next = new Map<string, boolean>();
  let changed = false;

  for (const definition of index.definitions.values()) {
    const resourceIds = groups.entitiesByType.get(definition.wireName);
    if (resourceIds === undefined) continue;
    for (const resourceId of resourceIds) {
      const context: EvalContext = {
        index,
        groups,
        valuation: current,
        entityType: definition.wireName,
        resourceId,
        actor,
        nowMs,
      };
      if (stepResourcePermissions(context, definition.permissions, current, next)) {
        changed = true;
      }
    }
  }

  return { next, changed };
}

/** Compute the converged fixed-point permission table for one actor across all known resources. */
export function computeActorValuation(
  index: IndexedAccessModel,
  tuples: readonly StoredAccessTuple[],
  actor: SubjectRef,
  nowMs: number,
  extraResource?: { readonly type: string; readonly id: string },
): {
  readonly groups: TupleGroups;
  readonly valuation: ReadonlyMap<string, boolean>;
} {
  const groups = groupTuples(tuples, nowMs, extraResource);
  let current = new Map<string, boolean>();
  let totalNodes = 0;
  for (const ids of groups.entitiesByType.values()) {
    totalNodes += ids.size;
  }
  const maxIterations = Math.max(8, totalNodes * 4 + 4);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const step = stepValuation(index, groups, current, actor, nowMs);
    current = step.next;
    if (!step.changed) break;
  }

  return { groups, valuation: current };
}

/** Fast resource lookup using the converged actor valuation. */
export function evaluateLookupResources(
  index: IndexedAccessModel,
  tuples: readonly StoredAccessTuple[],
  actor: SubjectRef,
  resourceType: string,
  permissionName: string,
  nowMs: number,
): readonly string[] {
  if (index.permissionsByEntity.get(resourceType)?.has(permissionName) !== true) {
    return [];
  }
  const { groups, valuation } = computeActorValuation(index, tuples, actor, nowMs);
  const candidateIds = groups.entitiesByType.get(resourceType);
  if (candidateIds === undefined) return [];
  const allowedIds: string[] = [];
  for (const resourceId of candidateIds) {
    if (valuation.get(valuationKey(resourceType, resourceId, permissionName)) === true) {
      allowedIds.push(resourceId);
    }
  }
  return allowedIds.sort();
}
