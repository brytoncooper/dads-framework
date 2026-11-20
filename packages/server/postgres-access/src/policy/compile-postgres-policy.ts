import {
  type AuthorizationModelDefinition,
  type CompiledPermissionExpression,
  type NormalizedPermissionCheck,
  type NormalizedResourceLookup,
} from "./policy-model.js";
import type { PostgresQuery } from "../postgres-types.js";
import { readLinearPath } from "./compile-linear-check.js";
import { compileLinearBatchBranch } from "./compile-linear-batch.js";
import { compileSharedPointCheck } from "./compile-shared-point-check.js";
import { compileReversePermission } from "./compile-reverse-policy.js";
import {
  QueryBuilder,
  relatedEntity,
  subjectReachability,
  TUPLES,
} from "./policy-sql.js";

export type CompiledAuthorizationQuery = PostgresQuery & {
  readonly kind: "check" | "check-many" | "lookup" | "candidate-predicate";
};

export type PostgresAuthorizationCandidateBinding = {
  readonly tableAlias: "dad_authorization_candidate";
  readonly resourceIdColumn: "resource_id";
};

/** Fixed outer binding used only by named integration adapters. */
export const POSTGRES_AUTHORIZATION_CANDIDATE_BINDING: PostgresAuthorizationCandidateBinding =
  Object.freeze({
    tableAlias: "dad_authorization_candidate",
    resourceIdColumn: "resource_id",
  });

type SqlReference = {
  readonly type: string;
  readonly id: string;
  readonly entity: string;
};

/** Compiles one permission decision into a parameterized Postgres Boolean query. */
export function compilePostgresCheck(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedPermissionCheck,
): CompiledAuthorizationQuery & { readonly canPrepare: boolean } {
  const builder = new QueryBuilder();
  const namespaceSql = builder.value(namespace);
  const expression = compilePermission(
    model,
    builder,
    namespaceSql,
    {
      type: builder.value(request.subject.type),
      id: builder.value(request.subject.id),
      entity: request.subject.type,
    },
    {
      type: builder.value(request.resource.type),
      id: builder.value(request.resource.id),
      entity: request.resource.type,
    },
    request.permission,
    new Set(),
  );
  if (Buffer.byteLength(expression) > 64 * 1024)
    return compileSharedPointCheck(model, namespace, request);
  return Object.freeze({
    kind: "check",
    text: `SELECT (${expression}) AS allowed`,
    values: builder.values,
    // Five bindings describe the namespace and endpoints. Each remaining
    // binding adds one relation or arrow to the ordinary permission plan.
    canPrepare: builder.values.length <= 9 && builder.throughCount <= 2,
  });
}

/** One ordinal input relation and one SQL statement preserve input ordering and duplicates. */
export function compilePostgresCheckMany(
  model: AuthorizationModelDefinition,
  namespace: string,
  requests: readonly NormalizedPermissionCheck[],
): CompiledAuthorizationQuery {
  const builder = new QueryBuilder();
  const namespaceSql = builder.value(namespace);
  const tuples = requests.map(
    (request, ordinal) =>
      `(${builder.value(ordinal)}, ${builder.value(request.subject.type)}, ${builder.value(request.subject.id)}, ${builder.value(request.resource.type)}, ${builder.value(request.resource.id)}, ${builder.value(request.permission)})`,
  );
  const shared: string[] = [];
  const branches = [
    ...new Set(
      requests.map(
        (request) => `${request.resource.type}\u0000${request.permission}`,
      ),
    ),
  ].map((identity) => {
    const [resourceType, permission] = splitIdentity(identity);
    if (readLinearPath(model, resourceType, permission) !== undefined) {
      const branch = compileLinearBatchBranch(model, builder, {
        namespace: namespaceSql,
        resourceType,
        permission,
        index: shared.length,
      });
      shared.push(branch.hits);
      return branch.decision;
    }
    const expression = compilePermission(
      model,
      builder,
      namespaceSql,
      { type: "i.subject_kind", id: "i.subject_id", entity: resourceType },
      { type: "i.resource_kind", id: "i.resource_id", entity: resourceType },
      permission,
      new Set(),
    );
    return `WHEN i.resource_kind = ${builder.value(resourceType)} AND i.permission = ${builder.value(permission)} THEN (${expression})`;
  });
  return Object.freeze({
    kind: "check-many",
    text: `WITH input(ordinal, subject_kind, subject_id, resource_kind, resource_id, permission) AS (VALUES ${tuples.join(", ")})${shared.map((query) => `, ${query}`).join("")} SELECT i.ordinal::integer AS ordinal, CASE ${branches.join(" ")} ELSE false END AS allowed FROM input i ORDER BY i.ordinal::integer`,
    values: builder.values,
  });
}

/**
 * Computes allowed IDs actor-first from the reverse subject index. It never
 * enumerates every resource of a kind in application memory or SQL.
 */
export function compilePostgresLookup(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedResourceLookup,
): CompiledAuthorizationQuery {
  const builder = new QueryBuilder();
  const namespaceSql = builder.value(namespace);
  const subject: SqlReference = {
    type: builder.value(request.subject.type),
    id: builder.value(request.subject.id),
    entity: request.subject.type,
  };
  const allowedResourceIds = compileReversePermission(
    model,
    builder,
    namespaceSql,
    request.resourceType,
    request.permission,
    new Set(),
  );
  // Keep the recursive work table on the outer side of each indexed hop.
  // Flattening the LATERAL probe can scan the namespace once per iteration.
  return Object.freeze({
    kind: "lookup",
    text: `WITH RECURSIVE ${subjectReachability(namespaceSql, subject.type, subject.id)} SELECT DISTINCT allowed_resource.resource_id FROM (${allowedResourceIds}) allowed_resource ORDER BY allowed_resource.resource_id`,
    values: builder.values,
  });
}

/**
 * Compiles one descriptor's permission against the fixed integration candidate
 * binding. The caller supplies neither SQL text nor an identifier.
 */
export function compilePostgresCandidatePredicate(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedResourceLookup,
): CompiledAuthorizationQuery {
  const builder = new QueryBuilder();
  const namespaceSql = builder.value(namespace);
  const expression = compilePermission(
    model,
    builder,
    namespaceSql,
    {
      type: builder.value(request.subject.type),
      id: builder.value(request.subject.id),
      entity: request.subject.type,
    },
    {
      type: builder.value(request.resourceType),
      id: `${POSTGRES_AUTHORIZATION_CANDIDATE_BINDING.tableAlias}.${POSTGRES_AUTHORIZATION_CANDIDATE_BINDING.resourceIdColumn}`,
      entity: request.resourceType,
    },
    request.permission,
    new Set(),
  );
  return Object.freeze({
    kind: "candidate-predicate",
    text: `(${expression})`,
    values: builder.values,
  });
}

function compilePermission(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  subject: SqlReference,
  resource: SqlReference,
  permissionName: string,
  active: Set<string>,
): string {
  const definition = model.permissions.find(
    (candidate) =>
      candidate.wireName === permissionName &&
      candidate.entity === resource.entity,
  );
  if (!definition)
    throw new Error(
      `Postgres policy cannot find permission ${permissionName}.`,
    );
  const identity = `${resource.entity}\u0000${permissionName}`;
  if (active.has(identity))
    throw new Error(
      "Postgres SQL compilation does not yet support a cycle through permissions. Subject-set cycles are supported by recursive relation SQL; rewrite this permission-through cycle or add a dedicated recursive permission compiler.",
    );
  active.add(identity);
  try {
    return compileExpression(
      model,
      builder,
      namespace,
      subject,
      resource,
      definition.expression,
      active,
    );
  } finally {
    active.delete(identity);
  }
}

function compileExpression(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  subject: SqlReference,
  resource: SqlReference,
  expression: CompiledPermissionExpression,
  active: Set<string>,
): string {
  if (expression.kind === "relation")
    return compileRelationMembership(
      builder,
      namespace,
      subject,
      resource,
      expression.relation,
    );
  if (expression.kind === "through") {
    const relationSql = builder.value(expression.relation);
    const throughAlias = builder.throughAlias();
    const related: SqlReference = {
      type: `${throughAlias}.subject_kind`,
      id: `${throughAlias}.subject_id`,
      entity: relatedEntity(model, resource.entity, expression.relation),
    };
    const child = compilePermissionForRelated(
      model,
      builder,
      namespace,
      subject,
      related,
      expression.permission,
      active,
    );
    // OFFSET 0 keeps each arrow a correlated subplan. Pulling arrows up
    // into semijoins can repeatedly execute the nested membership query.
    return `EXISTS (SELECT 1 FROM ${TUPLES} ${throughAlias} WHERE ${throughAlias}.namespace = ${namespace} AND ${throughAlias}.resource_kind = ${resource.type} AND ${throughAlias}.resource_id = ${resource.id} AND ${throughAlias}.relation = ${relationSql} AND ${throughAlias}.subject_is_wildcard = false AND ${throughAlias}.subject_relation = '' AND (${child}) OFFSET 0)`;
  }
  if (expression.kind === "exclude")
    return `((${compileExpression(model, builder, namespace, subject, resource, expression.include, active)}) AND NOT (${compileExpression(model, builder, namespace, subject, resource, expression.exclude, active)}))`;
  const joiner = expression.kind === "any-of" ? " OR " : " AND ";
  return `(${expression.expressions.map((child) => `(${compileExpression(model, builder, namespace, subject, resource, child, active)})`).join(joiner)})`;
}

function compilePermissionForRelated(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  subject: SqlReference,
  resource: SqlReference,
  permission: string,
  active: Set<string>,
): string {
  const definition = model.permissions.find(
    (candidate) =>
      candidate.wireName === permission && candidate.entity === resource.entity,
  );
  if (!definition)
    throw new Error("Postgres policy is missing a through permission.");
  return compilePermission(
    model,
    builder,
    namespace,
    subject,
    resource,
    permission,
    active,
  );
}

/**
 * The recursive UNION deduplicates usersets, including cycles and diamonds.
 * Keep each hop correlated so stale statistics cannot select a repeated
 * namespace scan in place of a tuple key lookup.
 */
function compileRelationMembership(
  builder: QueryBuilder,
  namespace: string,
  subject: SqlReference,
  resource: SqlReference,
  relation: string,
): string {
  const relationSql = builder.value(relation);
  return `EXISTS (WITH RECURSIVE requested(resource_kind, resource_id, relation) AS (
    VALUES (${resource.type}, ${resource.id}, ${relationSql})
    UNION
    SELECT child.subject_kind, child.subject_id, child.subject_relation
    FROM requested requested_relation
    CROSS JOIN LATERAL (
      SELECT tuple.subject_kind, tuple.subject_id, tuple.subject_relation
      FROM ${TUPLES} tuple
      WHERE tuple.namespace = ${namespace}
        AND tuple.resource_kind = requested_relation.resource_kind
        AND tuple.resource_id = requested_relation.resource_id
        AND tuple.relation = requested_relation.relation
        AND tuple.subject_is_wildcard = false
        AND tuple.subject_relation <> ''
      OFFSET 0
    ) child
  )
  SELECT 1
  FROM ${TUPLES} tuple
  JOIN requested requested_relation
    ON requested_relation.resource_kind = tuple.resource_kind
    AND requested_relation.resource_id = tuple.resource_id
    AND requested_relation.relation = tuple.relation
  WHERE tuple.namespace = ${namespace}
    AND ((tuple.subject_is_wildcard = false AND tuple.subject_relation = '' AND tuple.subject_kind = ${subject.type} AND tuple.subject_id = ${subject.id}) OR (tuple.subject_is_wildcard = true AND tuple.subject_kind = ${subject.type}))
  LIMIT 1)`;
}

function splitIdentity(value: string): readonly [string, string] {
  const index = value.indexOf("\u0000");
  return [value.slice(0, index), value.slice(index + 1)];
}
