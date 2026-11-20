import {
  type AuthorizationModelDefinition,
  type CompiledPermissionExpression,
} from "./policy-model.js";
import { relatedEntity, TUPLES, type QueryBuilder } from "./policy-sql.js";

/** Compiles the set of resource IDs a subject may use for one permission. */
export function compileReversePermission(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  entity: string,
  permissionName: string,
  active: Set<string>,
): string {
  const definition = model.permissions.find(
    (candidate) =>
      candidate.wireName === permissionName && candidate.entity === entity,
  );
  if (!definition)
    throw new Error(
      `Postgres policy cannot find permission ${permissionName}.`,
    );
  const identity = `${entity}\u0000${permissionName}`;
  if (active.has(identity))
    throw new Error(
      "Postgres SQL compilation does not yet support a cycle through permissions. Subject-set cycles are supported by recursive relation SQL; rewrite this permission-through cycle or add a dedicated recursive permission compiler.",
    );
  active.add(identity);
  try {
    return compileReverseExpression(
      model,
      builder,
      namespace,
      entity,
      definition.expression,
      active,
    );
  } finally {
    active.delete(identity);
  }
}

function compileReverseExpression(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  entity: string,
  expression: CompiledPermissionExpression,
  active: Set<string>,
): string {
  if (expression.kind === "relation") {
    const resourceKind = builder.value(entity);
    const relation = builder.value(expression.relation);
    return `SELECT subject_reachable.resource_id FROM subject_reachable WHERE subject_reachable.resource_kind = ${resourceKind} AND subject_reachable.relation = ${relation}`;
  }
  if (expression.kind === "through") {
    const throughAlias = builder.throughAlias();
    const related = relatedEntity(model, entity, expression.relation);
    const relatedResourceIds = compileReversePermission(
      model,
      builder,
      namespace,
      related,
      expression.permission,
      active,
    );
    const resourceKind = builder.value(entity);
    const relation = builder.value(expression.relation);
    const relatedKind = builder.value(related);
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
        OFFSET 0
      ) match`;
  }
  if (expression.kind === "exclude") {
    const include = compileReverseExpression(
      model,
      builder,
      namespace,
      entity,
      expression.include,
      active,
    );
    const exclude = compileReverseExpression(
      model,
      builder,
      namespace,
      entity,
      expression.exclude,
      active,
    );
    return `(${include}) EXCEPT (${exclude})`;
  }
  const operator = expression.kind === "any-of" ? "UNION" : "INTERSECT";
  return expression.expressions
    .map(
      (child) =>
        `(${compileReverseExpression(model, builder, namespace, entity, child, active)})`,
    )
    .join(` ${operator} `);
}
