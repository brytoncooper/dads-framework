import {
  emitAccessIr,
  type AccessIrDefinition,
  type AccessIrTerm,
  type AccessModel,
} from "@dads-framework/access";

import {
  compileSqliteColumnRelations,
  type SqliteColumnRelationBinding,
} from "./column-relations.js";
import { analyzePermissionCycles } from "./cycle-analysis.js";
import {
  permissionKey,
  type SqliteArrowTarget,
  type SqliteAuthorizationModel,
  type SqliteAuthorizationPermission,
  type SqliteAuthorizationRelation,
  type SqlitePermissionExpression,
} from "./policy-model.js";

export type CompiledSqliteAccessPolicy = {
  readonly model: SqliteAuthorizationModel;
  /** The engine's permission name for an authored permission or direct relation. */
  permissionName(entity: string, name: string): string | undefined;
};

type LoweringContext = {
  readonly byName: ReadonlyMap<string, AccessIrDefinition>;
  readonly generated: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

/** Compile an `@dads-framework/access` model into the lowered SQLite authorization model. */
export function compileAccessPolicy(
  access: AccessModel,
  columnRelations?: readonly SqliteColumnRelationBinding[],
): CompiledSqliteAccessPolicy {
  const definitions = emitAccessIr(access);
  const byName = new Map(definitions.map((entry) => [entry.wireName, entry]));
  const generated = new Map(
    definitions.map((entry) => [entry.wireName, rolePermissions(entry)]),
  );
  const context: LoweringContext = { byName, generated };
  const permissions = definitions.flatMap((entry) =>
    compileEntityPermissions(entry, context),
  );
  const permissionByKey = new Map(
    permissions.map((entry) => [
      permissionKey(entry.entity, entry.wireName),
      entry,
    ]),
  );
  const cyclicSccsByKey = analyzePermissionCycles(permissions);
  const relations = definitions.flatMap(lowerRelations);
  const compiledColumns = compileSqliteColumnRelations(
    { relations },
    columnRelations,
  );
  const model: SqliteAuthorizationModel = {
    entities: definitions.map((entry, index) => ({
      wireName: entry.wireName,
      sourceName: `entity_${index}`,
    })),
    relations,
    permissions,
    permissionByKey,
    cyclicSccsByKey,
    ...(compiledColumns.length === 0
      ? {}
      : { columnRelations: compiledColumns }),
  };
  return {
    model,
    permissionName: (entity, name) =>
      resolvePermissionName(context, entity, name),
  };
}

function resolvePermissionName(
  context: LoweringContext,
  entity: string,
  name: string,
): string | undefined {
  const definition = context.byName.get(entity);
  if (definition?.permissions.some((entry) => entry.name === name)) {
    return name;
  }
  return context.generated.get(entity)?.get(name);
}

function lowerRelations(
  definition: AccessIrDefinition,
): readonly SqliteAuthorizationRelation[] {
  return definition.roles.map((role, index) => ({
    entity: definition.wireName,
    sourceName: `relation_${index}`,
    wireName: role.name,
    targets: role.subjects.map((subject) => {
      if (subject.kind === "userset") {
        return {
          kind: "subject-set",
          entity: subject.wireName,
          relation: subject.relation,
        };
      }
      return {
        kind: subject.kind === "type" ? "entity" : "wildcard",
        entity: subject.wireName,
      };
    }),
  }));
}

function compileEntityPermissions(
  definition: AccessIrDefinition,
  context: LoweringContext,
): readonly SqliteAuthorizationPermission[] {
  const authored = lowerPermissions(definition, context);
  const wrappers =
    context.generated.get(definition.wireName) ?? new Map<string, string>();
  const relationWrappers = [...wrappers].map(
    ([relation, wireName], index): SqliteAuthorizationPermission => ({
      entity: definition.wireName,
      sourceName: `relation_permission_${index}`,
      wireName,
      expression: { kind: "relation", relation },
    }),
  );
  return [...authored, ...relationWrappers];
}

function lowerPermissions(
  definition: AccessIrDefinition,
  context: LoweringContext,
): readonly SqliteAuthorizationPermission[] {
  const byName = new Map(
    definition.permissions.map((entry) => [entry.name, entry.terms]),
  );
  const cached = new Map<string, SqlitePermissionExpression>();
  const visiting = new Set<string>();

  function resolve(name: string): SqlitePermissionExpression {
    const existing = cached.get(name);
    if (existing !== undefined) return existing;
    if (visiting.has(name)) {
      throw new Error(
        `Cyclic permission reference ${definition.wireName}#${name}`,
      );
    }
    const terms = byName.get(name);
    if (terms === undefined) {
      throw new Error(`Unknown permission ${definition.wireName}#${name}`);
    }
    visiting.add(name);
    const compiled = group("any-of", terms.map(lower));
    visiting.delete(name);
    cached.set(name, compiled);
    return compiled;
  }

  function lower(term: AccessIrTerm): SqlitePermissionExpression {
    if (term.kind === "permission") return resolve(term.name);
    if (term.kind === "through" || term.kind === "through-all") {
      return lowerArrow(definition, context, term);
    }
    return lowerLocal(term, lower);
  }

  return definition.permissions.map(({ name }, index) => ({
    entity: definition.wireName,
    sourceName: `permission_${index}`,
    wireName: name,
    expression: resolve(name),
  }));
}

function lowerArrow(
  definition: AccessIrDefinition,
  context: LoweringContext,
  term: Extract<AccessIrTerm, { kind: "through" | "through-all" }>,
): SqlitePermissionExpression {
  const role = definition.roles.find(({ name }) => name === term.roleName);
  if (role === undefined) {
    throw new Error(
      `Unknown arrow relation ${definition.wireName}#${term.roleName}`,
    );
  }
  const entityTargets = role.subjects.filter(
    (subject) => subject.kind === "type",
  );
  if (entityTargets.length === 0) {
    throw new Error(
      `SQLite arrow ${definition.wireName}#${term.roleName} requires at least one direct entity target`,
    );
  }
  const targets = resolveArrowTargets(
    entityTargets,
    term.targetPermission,
    context,
  );
  if (targets.length === 0) {
    throw new Error(
      `Unknown arrow target ${definition.wireName}#${term.roleName}->${term.targetPermission}`,
    );
  }
  return { kind: term.kind, relation: term.roleName, targets };
}

function resolveArrowTargets(
  entityTargets: readonly { readonly wireName: string }[],
  targetPermission: string,
  context: LoweringContext,
): readonly SqliteArrowTarget[] {
  const seen = new Set<string>();
  const resolved: SqliteArrowTarget[] = [];
  for (const target of entityTargets) {
    if (seen.has(target.wireName)) continue;
    seen.add(target.wireName);
    const permission = resolvePermissionName(
      context,
      target.wireName,
      targetPermission,
    );
    if (permission !== undefined) {
      resolved.push({ entity: target.wireName, permission });
    }
  }
  return resolved;
}

function lowerLocal(
  term: Exclude<
    AccessIrTerm,
    { kind: "permission" | "through" | "through-all" }
  >,
  lower: (entry: AccessIrTerm) => SqlitePermissionExpression,
): SqlitePermissionExpression {
  switch (term.kind) {
    case "role":
      return { kind: "relation", relation: term.name };
    case "or":
      return group("any-of", term.terms.map(lower));
    case "both":
      return group("all-of", [lower(term.left), lower(term.right)]);
    case "gated":
      return group("all-of", [lower(term.term), lower(term.condition)]);
    case "excluding":
      return {
        kind: "exclude",
        include: lower(term.term),
        exclude: lower(term.banned),
      };
  }
}

function group(
  kind: "any-of" | "all-of",
  expressions: readonly SqlitePermissionExpression[],
): SqlitePermissionExpression {
  if (expressions.length === 0) {
    throw new Error(
      "SQLite authorization requires nonempty permission expressions",
    );
  }
  const [only] = expressions;
  return expressions.length === 1 && only !== undefined
    ? only
    : { kind, expressions };
}

function rolePermissions(
  definition: AccessIrDefinition,
): ReadonlyMap<string, string> {
  const names = new Set([
    ...definition.roles.map((entry) => entry.name),
    ...definition.permissions.map((entry) => entry.name),
  ]);
  const wrappers = new Map<string, string>();
  let suffix = 0;
  for (const role of definition.roles) {
    let generated: string;
    do {
      generated = `dads_relation_${suffix}`;
      suffix += 1;
    } while (names.has(generated));
    wrappers.set(role.name, generated);
  }
  return wrappers;
}
