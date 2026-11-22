import {
  permissionKey,
  type SqliteAuthorizationPermission,
  type CompiledCyclicScc,
  type SqlitePermissionExpression,
  type GuardCondition,
  type RecursiveBaseClause,
  type RecursiveStepClause,
} from "./policy-model.js";

type NormalizedClause = RecursiveBaseClause | RecursiveStepClause;

type TarjanState = {
  nextIndex: number;
  readonly indexByNode: Map<string, number>;
  readonly lowlinkByNode: Map<string, number>;
  readonly onStack: Set<string>;
  readonly stack: string[];
  readonly components: string[][];
};

/** Discover cyclic `(entity, permission)` SCCs and reject non-monotonic cycles. */
export function analyzePermissionCycles(
  permissions: readonly SqliteAuthorizationPermission[],
): ReadonlyMap<string, CompiledCyclicScc> {
  const byKey = new Map(
    permissions.map((entry) => [
      permissionKey(entry.entity, entry.wireName),
      entry,
    ]),
  );
  const edges = buildDependencyGraph(permissions);
  const components = findStronglyConnectedComponents(edges);
  const result = new Map<string, CompiledCyclicScc>();
  let sccId = 0;

  for (const component of components) {
    if (!isCyclicComponent(component, edges)) continue;
    const compiled = compileCyclicScc(sccId, component, byKey);
    sccId += 1;
    for (const member of component) {
      result.set(member, compiled);
    }
  }
  return result;
}

function buildDependencyGraph(
  permissions: readonly SqliteAuthorizationPermission[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const graph = new Map<string, Set<string>>();
  for (const permission of permissions) {
    const key = permissionKey(permission.entity, permission.wireName);
    const targets = new Set<string>();
    collectArrowTargets(permission.expression, targets);
    graph.set(key, targets);
  }
  return graph;
}

function collectArrowTargets(
  expression: SqlitePermissionExpression,
  targets: Set<string>,
): void {
  switch (expression.kind) {
    case "relation":
      return;
    case "through":
    case "through-all":
      for (const target of expression.targets) {
        targets.add(permissionKey(target.entity, target.permission));
      }
      return;
    case "exclude":
      collectArrowTargets(expression.include, targets);
      collectArrowTargets(expression.exclude, targets);
      return;
    case "any-of":
    case "all-of":
      for (const child of expression.expressions) {
        collectArrowTargets(child, targets);
      }
      return;
  }
}

function findStronglyConnectedComponents(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const state: TarjanState = {
    nextIndex: 0,
    indexByNode: new Map(),
    lowlinkByNode: new Map(),
    onStack: new Set(),
    stack: [],
    components: [],
  };
  for (const node of edges.keys()) {
    if (!state.indexByNode.has(node)) {
      strongConnect(node, edges, state);
    }
  }
  return state.components;
}

function strongConnect(
  node: string,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  state: TarjanState,
): void {
  const index = state.nextIndex;
  state.nextIndex += 1;
  state.indexByNode.set(node, index);
  state.lowlinkByNode.set(node, index);
  state.stack.push(node);
  state.onStack.add(node);

  visitNeighbors(node, edges, state);

  if (state.lowlinkByNode.get(node) === index) {
    popComponent(node, state);
  }
}

function visitNeighbors(
  node: string,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  state: TarjanState,
): void {
  const neighbors = edges.get(node);
  if (neighbors === undefined) return;
  for (const neighbor of neighbors) {
    if (!edges.has(neighbor)) continue;
    const neighborIndex = state.indexByNode.get(neighbor);
    if (neighborIndex === undefined) {
      strongConnect(neighbor, edges, state);
      updateLowlink(node, state.lowlinkByNode.get(neighbor), state);
    } else if (state.onStack.has(neighbor)) {
      updateLowlink(node, neighborIndex, state);
    }
  }
}

function updateLowlink(
  node: string,
  candidate: number | undefined,
  state: TarjanState,
): void {
  const current = state.lowlinkByNode.get(node);
  if (current !== undefined && candidate !== undefined && candidate < current) {
    state.lowlinkByNode.set(node, candidate);
  }
}

function popComponent(root: string, state: TarjanState): void {
  const component: string[] = [];
  for (;;) {
    const item = state.stack.pop();
    if (item === undefined) break;
    state.onStack.delete(item);
    component.push(item);
    if (item === root) break;
  }
  state.components.push(component);
}

function isCyclicComponent(
  component: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (component.length > 1) return true;
  const [only] = component;
  if (only === undefined) return false;
  return edges.get(only)?.has(only) ?? false;
}

function compileCyclicScc(
  id: number,
  component: readonly string[],
  byKey: ReadonlyMap<string, SqliteAuthorizationPermission>,
): CompiledCyclicScc {
  const members = new Set(component);
  const baseClauses: RecursiveBaseClause[] = [];
  const stepClauses: RecursiveStepClause[] = [];

  for (const key of component) {
    const permission = byKey.get(key);
    if (permission === undefined) continue;
    const clauses = decomposeExpression(
      permission.entity,
      permission.wireName,
      permission.expression,
      members,
    );
    for (const clause of clauses) {
      if (clause.kind === "base") {
        baseClauses.push(clause);
      } else {
        stepClauses.push(clause);
      }
    }
  }
  return { id, members, baseClauses, stepClauses };
}

function referencesScc(
  expression: SqlitePermissionExpression,
  members: ReadonlySet<string>,
): boolean {
  switch (expression.kind) {
    case "relation":
      return false;
    case "through":
    case "through-all":
      return expression.targets.some((target) =>
        members.has(permissionKey(target.entity, target.permission)),
      );
    case "exclude":
      return (
        referencesScc(expression.include, members) ||
        referencesScc(expression.exclude, members)
      );
    case "any-of":
    case "all-of":
      return expression.expressions.some((child) =>
        referencesScc(child, members),
      );
  }
}

function decomposeExpression(
  entity: string,
  permission: string,
  expression: SqlitePermissionExpression,
  members: ReadonlySet<string>,
): readonly NormalizedClause[] {
  if (!referencesScc(expression, members)) {
    return [{ kind: "base", entity, permission, expression }];
  }
  switch (expression.kind) {
    case "relation":
      return [{ kind: "base", entity, permission, expression }];
    case "any-of":
      return expression.expressions.flatMap((child) =>
        decomposeExpression(entity, permission, child, members),
      );
    case "through":
      return decomposeThrough(entity, permission, expression, members);
    case "through-all":
      throw new Error(
        `SQLite authorization does not support non-monotonic cycle through ${entity}#${permission} (${expression.relation}.all)`,
      );
    case "exclude":
      return decomposeExclude(entity, permission, expression, members);
    case "all-of":
      return decomposeAllOf(entity, permission, expression, members);
  }
}

function decomposeThrough(
  entity: string,
  permission: string,
  expression: Extract<SqlitePermissionExpression, { kind: "through" }>,
  members: ReadonlySet<string>,
): readonly NormalizedClause[] {
  const external = expression.targets.filter(
    (target) => !members.has(permissionKey(target.entity, target.permission)),
  );
  const recursive = expression.targets.filter((target) =>
    members.has(permissionKey(target.entity, target.permission)),
  );
  const clauses: NormalizedClause[] = [];
  if (external.length > 0) {
    clauses.push({
      kind: "base",
      entity,
      permission,
      expression: {
        kind: "through",
        relation: expression.relation,
        targets: external,
      },
    });
  }
  for (const target of recursive) {
    clauses.push({
      kind: "step",
      entity,
      permission,
      relation: expression.relation,
      targetEntity: target.entity,
      targetPermission: target.permission,
      guards: [],
    });
  }
  return clauses;
}

function decomposeExclude(
  entity: string,
  permission: string,
  expression: Extract<SqlitePermissionExpression, { kind: "exclude" }>,
  members: ReadonlySet<string>,
): readonly NormalizedClause[] {
  if (referencesScc(expression.exclude, members)) {
    throw new Error(
      `SQLite authorization does not support non-monotonic cycle through excluding on ${entity}#${permission}`,
    );
  }
  const inner = decomposeExpression(
    entity,
    permission,
    expression.include,
    members,
  );
  return attachGuard(inner, {
    positive: false,
    expression: expression.exclude,
  });
}

function decomposeAllOf(
  entity: string,
  permission: string,
  expression: Extract<SqlitePermissionExpression, { kind: "all-of" }>,
  members: ReadonlySet<string>,
): readonly NormalizedClause[] {
  const recursive = expression.expressions.filter((child) =>
    referencesScc(child, members),
  );
  const external = expression.expressions.filter(
    (child) => !referencesScc(child, members),
  );
  if (recursive.length > 1 || recursive[0] === undefined) {
    throw new Error(
      `SQLite authorization does not support non-linear recursive intersection on ${entity}#${permission}`,
    );
  }
  let clauses = decomposeExpression(entity, permission, recursive[0], members);
  for (const guard of external) {
    clauses = attachGuard(clauses, { positive: true, expression: guard });
  }
  return clauses;
}

function attachGuard(
  clauses: readonly NormalizedClause[],
  guard: GuardCondition,
): readonly NormalizedClause[] {
  return clauses.map((clause) => {
    if (clause.kind === "step") {
      return { ...clause, guards: [...clause.guards, guard] };
    }
    const expression: SqlitePermissionExpression = guard.positive
      ? { kind: "all-of", expressions: [clause.expression, guard.expression] }
      : {
          kind: "exclude",
          include: clause.expression,
          exclude: guard.expression,
        };
    return { ...clause, expression };
  });
}
