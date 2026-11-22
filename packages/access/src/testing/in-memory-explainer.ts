import type { AccessIrPermission, AccessIrTerm } from "../core/ir.js";
import type { PermissionQuery, SubjectRef } from "../runtime/authorization.js";
import type {
  PermissionExplanation,
  PermissionTrace,
} from "./explain-format.js";
import {
  activeRoleTargets,
  checkRoleReachability,
  computeActorValuation,
  lookupTargetAccess,
  type TupleGroups,
  valuationKey,
} from "./in-memory-evaluator.js";
import {
  describeIrTerm,
  describePermissionTerms,
  type IndexedAccessModel,
  type StoredAccessTuple,
} from "./in-memory-model-index.js";

type TraceContext = {
  readonly index: IndexedAccessModel;
  readonly groups: TupleGroups;
  readonly valuation: ReadonlyMap<string, boolean>;
  readonly actor: SubjectRef;
  readonly nowMs: number;
  readonly traceStack: Set<string>;
};

function traceRoleTerm(
  context: TraceContext,
  entityType: string,
  resourceId: string,
  roleName: string,
): PermissionTrace {
  const reach = checkRoleReachability(
    context.groups,
    entityType,
    resourceId,
    roleName,
    context.actor,
    context.nowMs,
    new Set(),
  );
  if (reach.matched) {
    return {
      label: roleName,
      outcome: "ALLOW",
      ...(reach.witness === undefined ? {} : { detail: reach.witness }),
    };
  }
  return {
    label: roleName,
    outcome: "DENY",
    detail: reach.expiredWitness ?? "no active tuple",
  };
}

function traceThroughTerm(
  context: TraceContext,
  entityType: string,
  resourceId: string,
  term: Extract<AccessIrTerm, { readonly kind: "through" | "through-all" }>,
): PermissionTrace {
  const label = describeIrTerm(term);
  const targets = activeRoleTargets(
    context.groups,
    entityType,
    resourceId,
    term.roleName,
  );
  if (targets.length === 0) {
    return {
      label,
      outcome: "DENY",
      detail: `no active ${term.roleName} relationship`,
    };
  }
  const childTraces: PermissionTrace[] = [];
  let allowCount = 0;
  for (const target of targets) {
    const targetAllowed = lookupTargetAccess(
      context.index,
      context.groups,
      context.valuation,
      target.subjectType,
      target.subjectId,
      term.targetPermission,
      context.actor,
      context.nowMs,
    );
    if (targetAllowed) allowCount += 1;
    const subTrace = tracePermissionOrRole(
      context,
      target.subjectType,
      target.subjectId,
      term.targetPermission,
    );
    childTraces.push({
      label: `via ${target.subjectType}:${target.subjectId}#${term.targetPermission}`,
      outcome: targetAllowed ? "ALLOW" : "DENY",
      ...(subTrace.detail === undefined ? {} : { detail: subTrace.detail }),
      ...(subTrace.children === undefined
        ? {}
        : { children: subTrace.children }),
    });
  }
  const allowed =
    term.kind === "through" ? allowCount > 0 : allowCount === targets.length;
  return { label, outcome: allowed ? "ALLOW" : "DENY", children: childTraces };
}

function traceExcludingTerm(
  context: TraceContext,
  entityType: string,
  resourceId: string,
  term: Extract<AccessIrTerm, { readonly kind: "excluding" }>,
): PermissionTrace {
  const baseTrace = traceTerm(context, entityType, resourceId, term.term);
  const bannedTrace = traceTerm(context, entityType, resourceId, term.banned);
  const blocked = bannedTrace.outcome === "ALLOW";
  const annotatedBan: PermissionTrace = {
    ...bannedTrace,
    label: `unless(${bannedTrace.label})`,
    outcome: blocked ? "BLOCKED" : "ALLOW",
    detail: blocked
      ? (bannedTrace.detail ?? "matched exclusion")
      : "not excluded",
  };
  return {
    label: describeIrTerm(term),
    outcome: baseTrace.outcome === "ALLOW" && !blocked ? "ALLOW" : "DENY",
    children: [baseTrace, annotatedBan],
  };
}

function traceConjunctionTerm(
  context: TraceContext,
  entityType: string,
  resourceId: string,
  term: Extract<AccessIrTerm, { readonly kind: "gated" | "both" }>,
): PermissionTrace {
  const leftTerm = term.kind === "gated" ? term.term : term.left;
  const rightTerm = term.kind === "gated" ? term.condition : term.right;
  const leftTrace = traceTerm(context, entityType, resourceId, leftTerm);
  const rightTrace = traceTerm(context, entityType, resourceId, rightTerm);
  const allowed =
    leftTrace.outcome === "ALLOW" && rightTrace.outcome === "ALLOW";
  return {
    label: describeIrTerm(term),
    outcome: allowed ? "ALLOW" : "DENY",
    children: [leftTrace, rightTrace],
  };
}

function traceTerm(
  context: TraceContext,
  entityType: string,
  resourceId: string,
  term: AccessIrTerm,
): PermissionTrace {
  switch (term.kind) {
    case "role":
      return traceRoleTerm(context, entityType, resourceId, term.name);
    case "permission":
      return tracePermissionOrRole(context, entityType, resourceId, term.name);
    case "through":
    case "through-all":
      return traceThroughTerm(context, entityType, resourceId, term);
    case "gated":
    case "both":
      return traceConjunctionTerm(context, entityType, resourceId, term);
    case "excluding":
      return traceExcludingTerm(context, entityType, resourceId, term);
    case "or": {
      const children = term.terms.map((branch) =>
        traceTerm(context, entityType, resourceId, branch),
      );
      const allowed = children.some((child) => child.outcome === "ALLOW");
      return {
        label: describeIrTerm(term),
        outcome: allowed ? "ALLOW" : "DENY",
        children,
      };
    }
  }
}

function tracePermissionDefinition(
  context: TraceContext,
  entityType: string,
  resourceId: string,
  permission: AccessIrPermission,
): PermissionTrace {
  const allowed =
    context.valuation.get(
      valuationKey(entityType, resourceId, permission.name),
    ) === true;
  const label = `${permission.name} = ${describePermissionTerms(permission.terms)}`;
  const singleTerm =
    permission.terms.length === 1 ? permission.terms[0] : undefined;
  if (singleTerm !== undefined) {
    const inner = traceTerm(context, entityType, resourceId, singleTerm);
    return {
      label,
      outcome: allowed ? "ALLOW" : "DENY",
      ...(inner.detail === undefined ? {} : { detail: inner.detail }),
      ...(inner.children === undefined ? {} : { children: inner.children }),
    };
  }
  const children = permission.terms.map((term) =>
    traceTerm(context, entityType, resourceId, term),
  );
  return { label, outcome: allowed ? "ALLOW" : "DENY", children };
}

function tracePermissionOrRole(
  context: TraceContext,
  entityType: string,
  resourceId: string,
  name: string,
): PermissionTrace {
  const stackKey = valuationKey(entityType, resourceId, name);
  if (context.traceStack.has(stackKey)) {
    return {
      label: `${entityType}:${resourceId}#${name}`,
      outcome: context.valuation.get(stackKey) === true ? "ALLOW" : "DENY",
      detail: "cycle visited",
    };
  }
  const permission = context.index.permissionsByEntity
    .get(entityType)
    ?.get(name);
  if (permission !== undefined) {
    context.traceStack.add(stackKey);
    const trace = tracePermissionDefinition(
      context,
      entityType,
      resourceId,
      permission,
    );
    context.traceStack.delete(stackKey);
    return trace;
  }
  if (context.index.rolesByEntity.get(entityType)?.has(name) === true) {
    return traceRoleTerm(context, entityType, resourceId, name);
  }
  return {
    label: name,
    outcome: "DENY",
    detail: `unknown permission "${name}" on "${entityType}"`,
  };
}

/** Evaluate a permission check and return both the boolean decision and full trace tree. */
export function explainPermissionQuery(
  index: IndexedAccessModel,
  tuples: readonly StoredAccessTuple[],
  query: PermissionQuery,
  nowMs: number,
): PermissionExplanation {
  const { groups, valuation } = computeActorValuation(
    index,
    tuples,
    query.subject,
    nowMs,
    query.resource,
  );
  const permission = index.permissionsByEntity
    .get(query.resource.type)
    ?.get(query.permission);
  if (permission === undefined) {
    return {
      allowed: false,
      trace: {
        label: query.permission,
        outcome: "DENY",
        detail: `unknown permission "${query.permission}" on "${query.resource.type}"`,
      },
    };
  }
  const allowed =
    valuation.get(
      valuationKey(query.resource.type, query.resource.id, query.permission),
    ) === true;
  const context: TraceContext = {
    index,
    groups,
    valuation,
    actor: query.subject,
    nowMs,
    traceStack: new Set(),
  };
  const trace = tracePermissionOrRole(
    context,
    query.resource.type,
    query.resource.id,
    query.permission,
  );
  return { allowed, trace };
}
