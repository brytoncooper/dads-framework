import type { AccessModel, ResolvedAccessDefinition } from "./access-model.js";
import { through } from "./combinators.js";
import { isDslActor, isDslLazyResource, isDslResource } from "./dsl-actor.js";
import { discoverDslGraph, isDslHolderList } from "./dsl-discover.js";
import {
  getDslResourceRecord,
  registerDslResourceResolver,
  type DslResourceRecord,
} from "./dsl-resource.js";
import type {
  CompileAccessOptions,
  DslNode,
  InlineChildPermissionExpr,
} from "./dsl-resource-types.js";
import {
  createRoleRef,
  normalizePermissionExpr,
  termsReferenceThrough,
} from "./dsl-terms.js";
import type {
  DslActor,
  DslPermissionExpr,
  DslRoleHolder,
  DslSingleRoleHolder,
} from "./dsl-types.js";
import type { EntityHandle } from "./entity-handle.js";
import {
  isEntityHandleHolder,
  isExpirableHolder,
  isWildcardHolder,
} from "./holders.js";
import { isRoleToken, permissionToken, roleToken } from "./refs.js";
import type { PermissionTerm, PermissionToken, RoleToken } from "./refs.js";
import type { ScopeBindings } from "./scope-bindings.js";
import { allowVisibleOnRecordUntil } from "./visible-record-exceptions.js";

function targetWireNameOfSingle(
  entry: DslSingleRoleHolder,
): string | undefined {
  if (isDslLazyResource(entry)) return entry().wireName;
  if (isDslResource(entry) || isDslActor(entry)) return entry.wireName;
  if (isRoleToken(entry)) return entry.entityWireName;
  if (isExpirableHolder(entry)) return targetWireNameOfSingle(entry.holder);
  if (isWildcardHolder(entry)) return entry.entity.wireName;
  if (isEntityHandleHolder(entry)) return entry.wireName;
  return undefined;
}

function targetWireNameOf(holder: DslRoleHolder, fallback: string): string {
  if (isDslHolderList(holder)) {
    const first = holder[0];
    return (
      (first === undefined ? undefined : targetWireNameOfSingle(first)) ??
      fallback
    );
  }
  return targetWireNameOfSingle(holder) ?? fallback;
}

function snapshotRoleTokens(
  record: DslResourceRecord,
): Record<string, RoleToken> {
  const snapshot: Record<string, RoleToken> = {};
  for (const [roleName, token] of Object.entries(record.resource.roles)) {
    snapshot[roleName] = roleToken(record.wireName, roleName, token.holder);
  }
  return snapshot;
}

function attachParentRefsToContext(
  record: DslResourceRecord,
  roles: Record<string, RoleToken>,
  context: Record<string, unknown>,
): void {
  if (
    record.parentResource !== undefined &&
    record.parentRoleName !== undefined
  ) {
    const parentToken = roles[record.parentRoleName];
    if (parentToken !== undefined) {
      const parentWire = record.parentResource.wireName;
      const parentRef = createRoleRef(parentToken, () => parentWire);
      context["parent"] = parentRef;
      context[record.parentRoleName] = parentRef;
    }
  }
  if (record.parents.length > 0) {
    const parentsToken = roles["parent"];
    const firstParent = record.parents[0];
    if (parentsToken !== undefined && firstParent !== undefined) {
      context["parents"] = createRoleRef(
        parentsToken,
        () => firstParent.wireName,
      );
    }
  } else if (record.recursive && record.parentResource === undefined) {
    const selfToken = roles["parent"];
    if (selfToken !== undefined) {
      context["parent"] = createRoleRef(selfToken, () => record.wireName);
    }
  }
}

function buildCanContext(
  record: DslResourceRecord,
  roles: Record<string, RoleToken>,
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [roleName, holder] of Object.entries(record.declaredRoles)) {
    const token = roles[roleName];
    if (token !== undefined) {
      context[roleName] = createRoleRef(token, () =>
        targetWireNameOf(holder, record.wireName),
      );
    }
  }
  attachParentRefsToContext(record, roles, context);
  return context;
}

function inheritedPermissionNamesFor(
  record: DslResourceRecord,
  parentResolved: ResolvedAccessDefinition | undefined,
): readonly string[] {
  if (parentResolved === undefined) return [];
  if (record.inherit === "none") return [];
  const parentPerms = Object.keys(parentResolved.expressions);
  if (record.inherit === "all") return parentPerms;

  const parentPermSet = new Set(parentPerms);
  for (const permName of record.inherit) {
    if (!parentPermSet.has(permName)) {
      throw new Error(
        `child "${record.wireName}" cannot inherit missing permission "${permName}" from "${parentResolved.entity.wireName}"`,
      );
    }
  }
  return record.inherit;
}

function isInlineExprList(
  value: InlineChildPermissionExpr,
): value is readonly (DslPermissionExpr | undefined)[] {
  return Array.isArray(value);
}

function resolveInlineExpr(
  expr: InlineChildPermissionExpr,
  wireName: string,
  permName: string,
): DslPermissionExpr {
  if (expr === undefined) {
    throw new Error(
      `permission "${permName}" on "${wireName}" resolved to an undefined role or term`,
    );
  }
  if (!isInlineExprList(expr)) {
    return expr;
  }
  const checked: DslPermissionExpr[] = [];
  for (const item of expr) {
    if (item === undefined) {
      throw new Error(
        `permission "${permName}" on "${wireName}" contains an undefined role or term`,
      );
    }
    checked.push(item);
  }
  return checked;
}

function evaluateLocalExpressions(
  record: DslResourceRecord,
  roles: Record<string, RoleToken>,
): Record<string, readonly PermissionTerm[]> {
  if (record.canFn === undefined) return {};
  const raw = record.canFn(buildCanContext(record, roles));
  const result: Record<string, readonly PermissionTerm[]> = {};
  for (const [permName, expr] of Object.entries(raw)) {
    result[permName] = normalizePermissionExpr(
      resolveInlineExpr(expr, record.wireName, permName),
    );
  }
  return result;
}

function mergeOneInheritedPermission(
  permName: string,
  parentToken: RoleToken,
  parentWire: string,
  localTerms: readonly PermissionTerm[] | undefined,
): readonly PermissionTerm[] {
  const inheritedTerm = through(
    parentToken,
    permissionToken(parentWire, permName),
  );
  if (localTerms === undefined) return [inheritedTerm];
  if (termsReferenceThrough(localTerms, parentToken.roleName, permName)) {
    return localTerms;
  }
  return [inheritedTerm, ...localTerms];
}

function mergeInheritedAndLocal(
  record: DslResourceRecord,
  roles: Record<string, RoleToken>,
  parentResolved: ResolvedAccessDefinition | undefined,
  local: Record<string, readonly PermissionTerm[]>,
): Record<string, readonly PermissionTerm[]> {
  const expressions: Record<string, readonly PermissionTerm[]> = {};
  const inheritedNames = inheritedPermissionNamesFor(record, parentResolved);
  const parentToken =
    record.parentRoleName === undefined
      ? undefined
      : roles[record.parentRoleName];
  const parentWire = record.parentResource?.wireName;

  if (parentToken !== undefined && parentWire !== undefined) {
    for (const permName of inheritedNames) {
      expressions[permName] = mergeOneInheritedPermission(
        permName,
        parentToken,
        parentWire,
        local[permName],
      );
    }
  }

  for (const [permName, terms] of Object.entries(local)) {
    if (expressions[permName] === undefined) {
      expressions[permName] = terms;
    }
  }
  return expressions;
}

function applyRecursiveInheritance(
  record: DslResourceRecord,
  roles: Record<string, RoleToken>,
  expressions: Record<string, readonly PermissionTerm[]>,
): Record<string, readonly PermissionTerm[]> {
  if (!record.recursive) return expressions;
  const selfToken = roles["parent"];
  if (selfToken === undefined) return expressions;

  const updated: Record<string, readonly PermissionTerm[]> = {};
  for (const [permName, terms] of Object.entries(expressions)) {
    if (termsReferenceThrough(terms, "parent", permName)) {
      updated[permName] = terms;
    } else {
      updated[permName] = [
        ...terms,
        through(selfToken, permissionToken(record.wireName, permName)),
      ];
    }
  }
  return updated;
}

function resolveResourceRecord(
  record: DslResourceRecord,
  cache: Map<DslResourceRecord, ResolvedAccessDefinition>,
  resolving: Set<DslResourceRecord>,
): ResolvedAccessDefinition {
  const cached = cache.get(record);
  if (cached !== undefined) return cached;
  if (resolving.has(record)) {
    throw new Error(`cyclic parent inheritance involving "${record.wireName}"`);
  }
  resolving.add(record);

  const parentRecord =
    record.parentResource === undefined
      ? undefined
      : getDslResourceRecord(record.parentResource);
  const parentResolved =
    parentRecord === undefined
      ? undefined
      : resolveResourceRecord(parentRecord, cache, resolving);

  const roles = snapshotRoleTokens(record);
  const local = evaluateLocalExpressions(record, roles);
  const merged = mergeInheritedAndLocal(record, roles, parentResolved, local);
  const expressions = applyRecursiveInheritance(record, roles, merged);

  const permissions: Record<string, PermissionToken> = {};
  for (const permName of Object.keys(expressions)) {
    permissions[permName] = permissionToken(record.wireName, permName);
  }

  const definition: ResolvedAccessDefinition = {
    entity: record.handle,
    roles,
    permissions,
    expressions,
    granting: undefined,
    catalogOnly: [],
  };
  resolving.delete(record);
  cache.set(record, definition);
  return definition;
}

function actorDefinition(handle: EntityHandle): ResolvedAccessDefinition {
  return {
    entity: handle,
    roles: {},
    permissions: {},
    expressions: {},
    granting: undefined,
    catalogOnly: [],
  };
}

function validateBindings(
  bindings: readonly ScopeBindings[],
  wireNames: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const name = binding.entity.wireName;
    if (seen.has(name)) {
      throw new Error(`duplicate access model entry ${name}`);
    }
    seen.add(name);
    if (!wireNames.has(name)) {
      throw new Error(`scope bindings name missing access definition ${name}`);
    }
  }
}

/**
 * Compile DSL actors and resources into a standard `AccessModel`.
 * Automatically discovers inline `children`, `.child(...)` branches,
 * `parents`, referenced resources (including lazy thunks), and actors.
 */
export function compileAccess(
  nodes: readonly DslNode[],
  options?: CompileAccessOptions,
): AccessModel {
  const graph = discoverDslGraph(nodes);
  const resolvedCache = new Map<DslResourceRecord, ResolvedAccessDefinition>();
  const resolving = new Set<DslResourceRecord>();
  const definitions: ResolvedAccessDefinition[] = [];

  for (const handle of graph.actorHandles.values()) {
    definitions.push(actorDefinition(handle));
  }
  for (const record of graph.resources) {
    definitions.push(resolveResourceRecord(record, resolvedCache, resolving));
  }

  const wireNames = new Set(definitions.map((entry) => entry.entity.wireName));
  const bindings = options?.bindings ?? [];
  validateBindings(bindings, wireNames);

  const visibleRecordExceptions = (options?.visibleRecordExceptions ?? []).map(
    (entry) => allowVisibleOnRecordUntil(entry.until, entry),
  );

  const baseModel: AccessModel = {
    definitions,
    bindings: [...bindings],
    visibleRecordExceptions,
  };
  return options?.migrations === undefined
    ? baseModel
    : { ...baseModel, migrations: [...options.migrations] };
}

registerDslResourceResolver((node) => {
  const model = compileAccess([node]);
  const definition = model.definitions.find(
    (entry) => entry.entity.wireName === node.wireName,
  );
  if (definition === undefined) {
    throw new Error(
      `failed to resolve DSL resource definition for "${node.wireName}"`,
    );
  }
  return definition;
});

export type { DslActor, DslNode };
