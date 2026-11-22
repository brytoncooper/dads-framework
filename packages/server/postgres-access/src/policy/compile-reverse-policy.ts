import type {
  AuthorizationModelDefinition,
  CompiledArrowTarget,
  CompiledPermissionExpression,
} from "./policy-model.js";
import {
  analyzePermissionCycles,
  type PermissionCyclePlan,
} from "./permission-cycles.js";
import { compileRecursiveReverseLookup } from "./compile-recursive-policy.js";
import {
  notExpired,
  permissionIdentity,
  resolveArrowTargets,
  TUPLES,
  type QueryBuilder,
} from "./policy-sql.js";

type ReverseContext = {
  readonly model: AuthorizationModelDefinition;
  readonly cycles: PermissionCyclePlan;
  readonly builder: QueryBuilder;
  readonly namespace: string;
  readonly active: Set<string>;
  readonly deduplicate: boolean;
};

export type ReverseCompileOptions = {
  /**
   * When `false`, skips redundant `DISTINCT`/`UNION` deduplication on positive
   * branches because the caller evaluates the subquery inside an `IN (...)`
   * semi-join. Defaults to `true`.
   */
  readonly deduplicate?: boolean;
};

/** Compiles the set of resource IDs matching one permission expression. */
export function compileReverseExpressionQuery(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  entity: string,
  expression: CompiledPermissionExpression,
  active: Set<string>,
  options?: ReverseCompileOptions,
): string {
  const context: ReverseContext = {
    model,
    cycles: analyzePermissionCycles(model),
    builder,
    namespace,
    active,
    deduplicate: options?.deduplicate ?? true,
  };
  return compileReverseExpression(context, entity, expression);
}

/** Compiles the set of resource IDs a subject may use for one permission. */
export function compileReversePermission(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  entity: string,
  permissionName: string,
  active: Set<string>,
  options?: ReverseCompileOptions,
): string {
  const context: ReverseContext = {
    model,
    cycles: analyzePermissionCycles(model),
    builder,
    namespace,
    active,
    deduplicate: options?.deduplicate ?? true,
  };
  return compileReversePermissionNode(context, entity, permissionName);
}

function compileReversePermissionNode(
  context: ReverseContext,
  entity: string,
  permissionName: string,
): string {
  const definition = context.model.permissions.find(
    (candidate) =>
      candidate.wireName === permissionName && candidate.entity === entity,
  );
  if (!definition)
    throw new Error(
      `Postgres policy cannot find permission ${permissionName}.`,
    );
  const scc = context.cycles.sccFor(entity, permissionName);
  if (scc !== undefined) {
    return compileRecursiveReverseLookup({
      builder: context.builder,
      namespace: context.namespace,
      entryEntity: entity,
      entryPermission: permissionName,
      scc,
      compileExpression: (nodeEntity, expression) =>
        compileReverseExpression(context, nodeEntity, expression),
    });
  }
  const identity = permissionIdentity(entity, permissionName);
  if (context.active.has(identity))
    throw new Error(
      "Postgres SQL compilation does not support a cycle through permissions.",
    );
  context.active.add(identity);
  try {
    return compileReverseExpression(context, entity, definition.expression);
  } finally {
    context.active.delete(identity);
  }
}

function compileReverseExpression(
  context: ReverseContext,
  entity: string,
  expression: CompiledPermissionExpression,
): string {
  if (expression.kind === "relation") {
    const resourceKind = context.builder.value(entity);
    const relation = context.builder.value(expression.relation);
    return `SELECT subject_reachable.resource_id FROM subject_reachable WHERE subject_reachable.resource_kind = ${resourceKind} AND subject_reachable.relation = ${relation}`;
  }
  if (expression.kind === "through") {
    const targets = resolveArrowTargets(context.model, entity, expression);
    return compileReverseThrough(context, entity, expression.relation, targets);
  }
  if (expression.kind === "through-all") {
    const targets = resolveArrowTargets(context.model, entity, expression);
    return compileReverseThroughAll(
      context,
      entity,
      expression.relation,
      targets,
    );
  }
  if (expression.kind === "exclude") {
    const include = compileReverseExpression(
      context,
      entity,
      expression.include,
    );
    const exclude = compileReverseExpression(
      context,
      entity,
      expression.exclude,
    );
    return `(${include}) EXCEPT (${exclude})`;
  }
  const operator =
    expression.kind === "any-of"
      ? context.deduplicate
        ? "UNION"
        : "UNION ALL"
      : "INTERSECT";
  return expression.expressions
    .map((child) => `(${compileReverseExpression(context, entity, child)})`)
    .join(` ${operator} `);
}

function compileReverseThrough(
  context: ReverseContext,
  entity: string,
  relationName: string,
  targets: readonly CompiledArrowTarget[],
): string {
  const branches = targets.map((target) =>
    compileReverseThroughBranch(context, entity, relationName, target),
  );
  const joiner = context.deduplicate ? " UNION " : " UNION ALL ";
  return branches.length === 1 && branches[0] !== undefined
    ? branches[0]
    : branches.map((branch) => `(${branch})`).join(joiner);
}

function compileReverseThroughBranch(
  context: ReverseContext,
  entity: string,
  relationName: string,
  target: CompiledArrowTarget,
): string {
  const { builder, namespace } = context;
  const throughAlias = builder.throughAlias();
  const relatedResourceIds = compileReversePermissionNode(
    context,
    target.entity,
    target.permission,
  );
  const resourceKind = builder.value(entity);
  const relation = builder.value(relationName);
  const relatedKind = builder.value(target.entity);
  if (!context.deduplicate) {
    return `SELECT ${throughAlias}.resource_id
      FROM (${relatedResourceIds}) related_resource
      JOIN ${TUPLES} ${throughAlias}
        ON ${throughAlias}.namespace = ${namespace}
        AND ${throughAlias}.resource_kind = ${resourceKind}
        AND ${throughAlias}.relation = ${relation}
        AND ${throughAlias}.subject_kind = ${relatedKind}
        AND ${throughAlias}.subject_id = related_resource.resource_id
        AND ${throughAlias}.subject_is_wildcard = false
        AND ${throughAlias}.subject_relation = ''
        AND ${notExpired(throughAlias)}`;
  }
  // Keep the reached IDs on the outer side of this hop. Without the
  // fence Postgres can re-run the inner permission chain for each found
  // resource, particularly when tuple statistics lag writes.
  return `SELECT DISTINCT match.resource_id
    FROM (${relatedResourceIds}) related_resource
    CROSS JOIN LATERAL (
      SELECT ${throughAlias}.resource_id
      FROM ${TUPLES} ${throughAlias}
      WHERE ${throughAlias}.namespace = ${namespace}
        AND ${throughAlias}.resource_kind = ${resourceKind}
        AND ${throughAlias}.relation = ${relation}
        AND ${throughAlias}.subject_kind = ${relatedKind}
        AND ${throughAlias}.subject_id = related_resource.resource_id
        AND ${throughAlias}.subject_is_wildcard = false
        AND ${throughAlias}.subject_relation = ''
        AND ${notExpired(throughAlias)}
      OFFSET 0
    ) match`;
}

function compileReverseThroughAll(
  context: ReverseContext,
  entity: string,
  relationName: string,
  targets: readonly CompiledArrowTarget[],
): string {
  const { builder, namespace } = context;
  const candidates = compileReverseThrough(
    context,
    entity,
    relationName,
    targets,
  );
  const allAlias = builder.throughAlias();
  const resourceKind = builder.value(entity);
  const relation = builder.value(relationName);
  const allowedChecks = targets.map((target) => {
    const targetKind = builder.value(target.entity);
    const allowedIds = compileReversePermissionNode(
      context,
      target.entity,
      target.permission,
    );
    return `(${allAlias}.subject_kind = ${targetKind} AND EXISTS (SELECT 1 FROM (${allowedIds}) allowed_target WHERE allowed_target.resource_id = ${allAlias}.subject_id))`;
  });
  return `SELECT DISTINCT candidate.resource_id
    FROM (${candidates}) candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${TUPLES} ${allAlias}
      WHERE ${allAlias}.namespace = ${namespace}
        AND ${allAlias}.resource_kind = ${resourceKind}
        AND ${allAlias}.resource_id = candidate.resource_id
        AND ${allAlias}.relation = ${relation}
        AND ${allAlias}.subject_is_wildcard = false
        AND ${allAlias}.subject_relation = ''
        AND ${notExpired(allAlias)}
        AND NOT (${allowedChecks.join(" OR ")})
    )`;
}
