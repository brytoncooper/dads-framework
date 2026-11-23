import type {
  AuthorizationModelDefinition,
  CompiledAuthorizationPermission,
  CompiledPermissionExpression,
} from "./policy-model.js";
import { permissionIdentity, resolveArrowTargets } from "./policy-sql.js";
import { findStronglyConnectedComponents } from "./tarjan-scc.js";

export type RecursiveEdge = {
  readonly fromEntity: string;
  readonly fromPermission: string;
  readonly relation: string;
  readonly toEntity: string;
  readonly toPermission: string;
  readonly guards: readonly CompiledPermissionExpression[];
};

export type RecursiveNodePlan = {
  readonly identity: string;
  readonly entity: string;
  readonly permission: string;
  readonly base: CompiledPermissionExpression | undefined;
};

export type RecursiveSccPlan = {
  readonly id: string;
  readonly members: ReadonlySet<string>;
  readonly nodes: readonly RecursiveNodePlan[];
  readonly edges: readonly RecursiveEdge[];
};

export type PermissionCyclePlan = {
  sccFor(entity: string, permission: string): RecursiveSccPlan | undefined;
};

type Decomposed = {
  readonly base: readonly CompiledPermissionExpression[];
  readonly edges: readonly RecursiveEdge[];
};

const planCache = new WeakMap<AuthorizationModelDefinition, PermissionCyclePlan>();

/** Computes and validates strongly connected components of permission arrows. */
export function analyzePermissionCycles(model: AuthorizationModelDefinition): PermissionCyclePlan {
  const cached = planCache.get(model);
  if (cached !== undefined) return cached;
  const plan = buildCyclePlan(model);
  planCache.set(model, plan);
  return plan;
}

function buildCyclePlan(model: AuthorizationModelDefinition): PermissionCyclePlan {
  const byId = new Map<string, CompiledAuthorizationPermission>();
  for (const permission of model.permissions) {
    byId.set(permissionIdentity(permission.entity, permission.wireName), permission);
  }
  const adjacency = buildAdjacency(model, byId);
  const sccs = findStronglyConnectedComponents(adjacency);
  const byIdentity = new Map<string, RecursiveSccPlan>();
  let index = 0;
  for (const members of sccs) {
    if (!isCyclicScc(members, adjacency)) continue;
    const scc = buildSccPlan(model, byId, members, index);
    index += 1;
    for (const member of members) {
      byIdentity.set(member, scc);
    }
  }
  return {
    sccFor: (entity, permission) => byIdentity.get(permissionIdentity(entity, permission)),
  };
}

function buildAdjacency(
  model: AuthorizationModelDefinition,
  byId: ReadonlyMap<string, CompiledAuthorizationPermission>,
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, readonly string[]>();
  for (const [id, permission] of byId) {
    const neighbors = new Set<string>();
    collectArrowNeighbors(model, permission.entity, permission.expression, neighbors);
    adjacency.set(
      id,
      [...neighbors].filter((neighbor) => byId.has(neighbor)),
    );
  }
  return adjacency;
}

function collectArrowNeighbors(
  model: AuthorizationModelDefinition,
  entity: string,
  expression: CompiledPermissionExpression,
  neighbors: Set<string>,
): void {
  if (expression.kind === "relation") return;
  if (expression.kind === "through" || expression.kind === "through-all") {
    for (const target of resolveArrowTargets(model, entity, expression)) {
      neighbors.add(permissionIdentity(target.entity, target.permission));
    }
    return;
  }
  if (expression.kind === "exclude") {
    collectArrowNeighbors(model, entity, expression.include, neighbors);
    collectArrowNeighbors(model, entity, expression.exclude, neighbors);
    return;
  }
  for (const child of expression.expressions) {
    collectArrowNeighbors(model, entity, child, neighbors);
  }
}

function isCyclicScc(members: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): boolean {
  if (members.length > 1) return true;
  const [only] = members;
  if (only === undefined) return false;
  return (adjacency.get(only) ?? []).includes(only);
}

function buildSccPlan(
  model: AuthorizationModelDefinition,
  byId: ReadonlyMap<string, CompiledAuthorizationPermission>,
  members: readonly string[],
  sccIndex: number,
): RecursiveSccPlan {
  const memberSet = new Set(members);
  const label = formatMembers(members);
  const nodes: RecursiveNodePlan[] = [];
  const edges: RecursiveEdge[] = [];
  for (const member of members) {
    const permission = byId.get(member);
    if (permission === undefined) continue;
    const decomposed = decomposeNode(model, permission, permission.expression, memberSet, label);
    nodes.push({
      identity: member,
      entity: permission.entity,
      permission: permission.wireName,
      base: combineAnyOf(decomposed.base),
    });
    edges.push(...decomposed.edges);
  }
  if (nodes.every((node) => node.base === undefined)) {
    throw new Error(`Unproductive permission cycle with no base case: ${label}`);
  }
  return { id: `scc_${String(sccIndex)}`, members: memberSet, nodes, edges };
}

function decomposeNode(
  model: AuthorizationModelDefinition,
  permission: CompiledAuthorizationPermission,
  expression: CompiledPermissionExpression,
  memberSet: ReadonlySet<string>,
  label: string,
): Decomposed {
  if (!referencesScc(model, permission.entity, expression, memberSet)) {
    return { base: [expression], edges: [] };
  }
  if (expression.kind === "exclude") {
    throw new Error(`Non-monotonic permission cycle through excluding is not supported: ${label}`);
  }
  if (expression.kind === "through-all") {
    throw new Error(`Non-monotonic permission cycle through through-all is not supported: ${label}`);
  }
  if (expression.kind === "through") {
    return decomposeThrough(model, permission, expression, memberSet);
  }
  if (expression.kind === "any-of") {
    return decomposeAnyOf(model, permission, expression.expressions, memberSet, label);
  }
  if (expression.kind === "all-of") {
    return decomposeAllOf(model, permission, expression.expressions, memberSet, label);
  }
  return { base: [expression], edges: [] };
}

function decomposeThrough(
  model: AuthorizationModelDefinition,
  permission: CompiledAuthorizationPermission,
  expression: Extract<CompiledPermissionExpression, { kind: "through" }>,
  memberSet: ReadonlySet<string>,
): Decomposed {
  const targets = resolveArrowTargets(model, permission.entity, expression);
  const inside = targets.filter((target) => memberSet.has(permissionIdentity(target.entity, target.permission)));
  const outside = targets.filter((target) => !memberSet.has(permissionIdentity(target.entity, target.permission)));
  const base: CompiledPermissionExpression[] = outside.length > 0 ? [{ ...expression, targets: outside }] : [];
  const edges: RecursiveEdge[] = inside.map((target) => ({
    fromEntity: permission.entity,
    fromPermission: permission.wireName,
    relation: expression.relation,
    toEntity: target.entity,
    toPermission: target.permission,
    guards: [],
  }));
  return { base, edges };
}

function decomposeAnyOf(
  model: AuthorizationModelDefinition,
  permission: CompiledAuthorizationPermission,
  expressions: readonly CompiledPermissionExpression[],
  memberSet: ReadonlySet<string>,
  label: string,
): Decomposed {
  const base: CompiledPermissionExpression[] = [];
  const edges: RecursiveEdge[] = [];
  for (const child of expressions) {
    const part = decomposeNode(model, permission, child, memberSet, label);
    base.push(...part.base);
    edges.push(...part.edges);
  }
  return { base, edges };
}

function decomposeAllOf(
  model: AuthorizationModelDefinition,
  permission: CompiledAuthorizationPermission,
  expressions: readonly CompiledPermissionExpression[],
  memberSet: ReadonlySet<string>,
  label: string,
): Decomposed {
  const recursive = expressions.filter((child) => referencesScc(model, permission.entity, child, memberSet));
  const guards = expressions.filter((child) => !referencesScc(model, permission.entity, child, memberSet));
  const [onlyRecursive] = recursive;
  if (recursive.length > 1 || onlyRecursive === undefined) {
    throw new Error(`Unsupported non-linear permission cycle: ${label}`);
  }
  const part = decomposeNode(model, permission, onlyRecursive, memberSet, label);
  return {
    base: part.base.map((entry) => ({
      kind: "all-of",
      expressions: [entry, ...guards],
    })),
    edges: part.edges.map((edge) => ({
      ...edge,
      guards: [...edge.guards, ...guards],
    })),
  };
}

function referencesScc(
  model: AuthorizationModelDefinition,
  entity: string,
  expression: CompiledPermissionExpression,
  memberSet: ReadonlySet<string>,
): boolean {
  if (expression.kind === "relation") return false;
  if (expression.kind === "through" || expression.kind === "through-all") {
    return resolveArrowTargets(model, entity, expression).some((target) =>
      memberSet.has(permissionIdentity(target.entity, target.permission)),
    );
  }
  if (expression.kind === "exclude") {
    return (
      referencesScc(model, entity, expression.include, memberSet) ||
      referencesScc(model, entity, expression.exclude, memberSet)
    );
  }
  return expression.expressions.some((child) => referencesScc(model, entity, child, memberSet));
}

function combineAnyOf(expressions: readonly CompiledPermissionExpression[]): CompiledPermissionExpression | undefined {
  if (expressions.length === 0) return undefined;
  const [only] = expressions;
  return expressions.length === 1 && only !== undefined ? only : { kind: "any-of", expressions };
}

function formatMembers(members: readonly string[]): string {
  return members.map((entry) => entry.replace("\u0000", "#")).join(", ");
}
