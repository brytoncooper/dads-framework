import type {
  AuthorizationModelDefinition,
  CompiledArrowTarget,
  CompiledPermissionExpression,
} from "./policy-model.js";
import { analyzePermissionCycles, type PermissionCyclePlan } from "./permission-cycles.js";
import { compileRecursiveForwardCheck } from "./compile-recursive-policy.js";
import { findColumnRelation } from "./column-relations.js";
import {
  compiledRelationCheck,
  isPolymorphicRelation,
  type LazySqlParam,
  notExpired,
  permissionIdentity,
  type QueryBuilder,
  resolveArrowTargets,
  TUPLES,
} from "./policy-sql.js";

export type SqlReference = {
  readonly type: string;
  readonly id: string;
  readonly entity: string;
};

export type ForwardContext = {
  readonly model: AuthorizationModelDefinition;
  readonly cycles: PermissionCyclePlan;
  readonly builder: QueryBuilder;
  readonly namespace: LazySqlParam;
  readonly subject: SqlReference;
  readonly active: Set<string>;
};

export function countRecursiveClauses(sql: string): number {
  let count = 0;
  let position = sql.indexOf("WITH RECURSIVE");
  while (position !== -1) {
    count += 1;
    position = sql.indexOf("WITH RECURSIVE", position + 14);
  }
  return count;
}

export function createForwardContext(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  subject: SqlReference,
): ForwardContext {
  return {
    model,
    cycles: analyzePermissionCycles(model),
    builder,
    namespace: builder.lazyValue(namespace),
    subject,
    active: new Set(),
  };
}

export function compileForwardPermission(
  context: ForwardContext,
  resource: SqlReference,
  permissionName: string,
): string {
  const definition = context.model.permissions.find(
    (candidate) => candidate.wireName === permissionName && candidate.entity === resource.entity,
  );
  if (!definition) throw new Error(`Postgres policy cannot find permission ${permissionName}.`);
  const scc = context.cycles.sccFor(resource.entity, permissionName);
  if (scc !== undefined) {
    return compileRecursiveForwardCheck({
      model: context.model,
      builder: context.builder,
      namespace: context.namespace,
      resource,
      entryEntity: resource.entity,
      entryPermission: permissionName,
      scc,
      compileExpression: (nodeResource, expression) => compileForwardExpression(context, nodeResource, expression),
    });
  }
  const identity = permissionIdentity(resource.entity, permissionName);
  if (context.active.has(identity))
    throw new Error("Postgres SQL compilation does not support a cycle through permissions.");
  context.active.add(identity);
  try {
    return compileForwardExpression(context, resource, definition.expression);
  } finally {
    context.active.delete(identity);
  }
}

function compileForwardExpression(
  context: ForwardContext,
  resource: SqlReference,
  expression: CompiledPermissionExpression,
): string {
  if (expression.kind === "relation") {
    return compiledRelationCheck(
      context.model,
      context.builder,
      context.namespace,
      context.subject.type,
      context.subject.id,
      resource.entity,
      resource.type,
      resource.id,
      expression.relation,
    );
  }
  if (expression.kind === "through") return compileThrough(context, resource, expression);
  if (expression.kind === "through-all") return compileThroughAll(context, resource, expression);
  if (expression.kind === "exclude")
    return `((${compileForwardExpression(context, resource, expression.include)}) AND NOT (${compileForwardExpression(context, resource, expression.exclude)}))`;
  const joiner = expression.kind === "any-of" ? " OR " : " AND ";
  return `(${expression.expressions.map((child) => `(${compileForwardExpression(context, resource, child)})`).join(joiner)})`;
}

function compileThrough(
  context: ForwardContext,
  resource: SqlReference,
  expression: Extract<CompiledPermissionExpression, { kind: "through" }>,
): string {
  const { builder } = context;
  const targets = resolveArrowTargets(context.model, resource.entity, expression);
  const columnRel = findColumnRelation(context.model, resource.entity, expression.relation);
  if (columnRel !== undefined && targets[0] !== undefined) {
    const throughAlias = builder.throughAlias();
    const entitySql = builder.value(columnRel.entity);
    const targetKindSql = builder.value(columnRel.targetEntity);
    const child = compileForwardPermission(
      context,
      {
        type: targetKindSql,
        id: `${throughAlias}.${columnRel.targetIdColumn}::text`,
        entity: targets[0].entity,
      },
      targets[0].permission,
    );
    return `EXISTS (SELECT 1 FROM ${columnRel.table} ${throughAlias} WHERE (${resource.type})::text = ${entitySql}::text AND ${throughAlias}.${columnRel.idColumn}::text = (${resource.id})::text AND ${throughAlias}.${columnRel.targetIdColumn} IS NOT NULL AND (${child}) OFFSET 0)`;
  }
  const namespace = context.namespace();
  const polymorphic = isPolymorphicRelation(context.model, resource.entity, expression.relation);
  const relationSql = builder.value(expression.relation);
  const throughAlias = builder.throughAlias();
  const branchSql = compileArrowTargetBranches(context, throughAlias, targets, polymorphic);
  // OFFSET 0 keeps each arrow a correlated subplan. Pulling arrows up
  // into semijoins can repeatedly execute the nested membership query.
  return `EXISTS (SELECT 1 FROM ${TUPLES} ${throughAlias} WHERE ${throughAlias}.namespace = ${namespace} AND ${throughAlias}.resource_kind = ${resource.type} AND ${throughAlias}.resource_id = ${resource.id} AND ${throughAlias}.relation = ${relationSql} AND ${throughAlias}.subject_is_wildcard = false AND ${throughAlias}.subject_relation = '' AND ${notExpired(throughAlias)} AND (${branchSql}) OFFSET 0)`;
}

function compileThroughAll(
  context: ForwardContext,
  resource: SqlReference,
  expression: Extract<CompiledPermissionExpression, { kind: "through-all" }>,
): string {
  const { builder } = context;
  const targets = resolveArrowTargets(context.model, resource.entity, expression);
  const columnRel = findColumnRelation(context.model, resource.entity, expression.relation);
  if (columnRel !== undefined && targets[0] !== undefined) {
    const existsAlias = builder.throughAlias();
    const checkAlias = builder.throughAlias();
    const entitySql = builder.value(columnRel.entity);
    const targetKindSql = builder.value(columnRel.targetEntity);
    const child = compileForwardPermission(
      context,
      {
        type: targetKindSql,
        id: `${checkAlias}.${columnRel.targetIdColumn}::text`,
        entity: targets[0].entity,
      },
      targets[0].permission,
    );
    const match = (alias: string) =>
      `(${resource.type})::text = ${entitySql}::text AND ${alias}.${columnRel.idColumn}::text = (${resource.id})::text AND ${alias}.${columnRel.targetIdColumn} IS NOT NULL`;
    return `(EXISTS (SELECT 1 FROM ${columnRel.table} ${existsAlias} WHERE ${match(existsAlias)}) AND NOT EXISTS (SELECT 1 FROM ${columnRel.table} ${checkAlias} WHERE ${match(checkAlias)} AND NOT (${child}) OFFSET 0))`;
  }
  const namespace = context.namespace();
  const polymorphic = isPolymorphicRelation(context.model, resource.entity, expression.relation);
  const relationSql = builder.value(expression.relation);
  const existsAlias = builder.throughAlias();
  const checkAlias = builder.throughAlias();
  const branchSql = compileArrowTargetBranches(context, checkAlias, targets, polymorphic);
  const parentMatch = (alias: string) =>
    `${alias}.namespace = ${namespace} AND ${alias}.resource_kind = ${resource.type} AND ${alias}.resource_id = ${resource.id} AND ${alias}.relation = ${relationSql} AND ${alias}.subject_is_wildcard = false AND ${alias}.subject_relation = '' AND ${notExpired(alias)}`;
  return `(EXISTS (SELECT 1 FROM ${TUPLES} ${existsAlias} WHERE ${parentMatch(existsAlias)}) AND NOT EXISTS (SELECT 1 FROM ${TUPLES} ${checkAlias} WHERE ${parentMatch(checkAlias)} AND NOT (${branchSql}) OFFSET 0))`;
}

function compileArrowTargetBranches(
  context: ForwardContext,
  tupleAlias: string,
  targets: readonly CompiledArrowTarget[],
  polymorphic: boolean,
): string {
  const branches = targets.map((target) => {
    const related: SqlReference = {
      type: `${tupleAlias}.subject_kind`,
      id: `${tupleAlias}.subject_id`,
      entity: target.entity,
    };
    const child = compileForwardPermission(context, related, target.permission);
    if (!polymorphic && targets.length === 1) return child;
    const targetKindSql = context.builder.value(target.entity);
    return `(${tupleAlias}.subject_kind = ${targetKindSql} AND (${child}))`;
  });
  return branches.join(" OR ");
}
