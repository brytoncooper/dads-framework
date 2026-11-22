import type {
  AuthorizationModelDefinition,
  CompiledArrowTarget,
  CompiledPermissionExpression,
  NormalizedPermissionCheck,
  NormalizedResourceLookup,
} from "./policy-model.js";
import type { PostgresQuery } from "../postgres-types.js";
import { readLinearPath } from "./compile-linear-check.js";
import { compileLinearBatchBranch } from "./compile-linear-batch.js";
import { compileSharedPointCheck } from "./compile-shared-point-check.js";
import { compileReversePermission } from "./compile-reverse-policy.js";
import {
  analyzePermissionCycles,
  type PermissionCyclePlan,
} from "./permission-cycles.js";
import { compileRecursiveForwardCheck } from "./compile-recursive-policy.js";
import {
  compiledRelationCheck,
  isPolymorphicRelation,
  notExpired,
  permissionIdentity,
  QueryBuilder,
  resolveArrowTargets,
  splitIdentity,
  subjectReachability,
  TUPLES,
} from "./policy-sql.js";

export type CompiledAuthorizationQuery = PostgresQuery & {
  readonly kind:
    | "check"
    | "check-many"
    | "lookup"
    | "subject-lookup"
    | "candidate-predicate";
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

type ForwardContext = {
  readonly model: AuthorizationModelDefinition;
  readonly cycles: PermissionCyclePlan;
  readonly builder: QueryBuilder;
  readonly namespace: string;
  readonly subject: SqlReference;
  readonly active: Set<string>;
};

/** Compiles one permission decision into a parameterized Postgres Boolean query. */
export function compilePostgresCheck(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedPermissionCheck,
): CompiledAuthorizationQuery & { readonly canPrepare: boolean } {
  const builder = new QueryBuilder();
  const context = createForwardContext(model, builder, namespace, {
    type: builder.value(request.subject.type),
    id: builder.value(request.subject.id),
    entity: request.subject.type,
  });
  const resource: SqlReference = {
    type: builder.value(request.resource.type),
    id: builder.value(request.resource.id),
    entity: request.resource.type,
  };
  const expression = compileForwardPermission(
    context,
    resource,
    request.permission,
  );
  if (Buffer.byteLength(expression) > 64 * 1024)
    return compileSharedPointCheck(model, namespace, request);
  return Object.freeze({
    kind: "check",
    text: `SELECT (${expression}) AS allowed`,
    values: builder.values,
    // Five bindings describe the namespace and endpoints. Each remaining
    // binding adds one relation or arrow to the ordinary permission plan.
    canPrepare:
      !builder.hasRecursive &&
      builder.values.length <= 9 &&
      builder.throughCount <= 2,
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
  const cycles = analyzePermissionCycles(model);
  const ordinals = requests.map((_, ordinal) => ordinal);
  const subjectKinds = requests.map((request) => request.subject.type);
  const subjectIds = requests.map((request) => request.subject.id);
  const resourceKinds = requests.map((request) => request.resource.type);
  const resourceIds = requests.map((request) => request.resource.id);
  const permissions = requests.map((request) => request.permission);
  const inputRows = `SELECT * FROM unnest(${builder.value(ordinals)}::integer[], ${builder.value(subjectKinds)}::text[], ${builder.value(subjectIds)}::text[], ${builder.value(resourceKinds)}::text[], ${builder.value(resourceIds)}::text[], ${builder.value(permissions)}::text[])`;
  const shared: string[] = [];
  const joins: string[] = [];
  const identities = [
    ...new Set(
      requests.map((request) =>
        permissionIdentity(request.resource.type, request.permission),
      ),
    ),
  ];
  const branches = identities.map((identity) =>
    compileBatchBranch(
      model,
      cycles,
      builder,
      namespaceSql,
      identity,
      shared,
      joins,
    ),
  );
  const joinSql = joins.length === 0 ? "" : ` ${joins.join(" ")}`;
  return Object.freeze({
    kind: "check-many",
    text: `WITH input(ordinal, subject_kind, subject_id, resource_kind, resource_id, permission) AS (${inputRows})${shared.map((query) => `, ${query}`).join("")} SELECT i.ordinal AS ordinal, CASE ${branches.join(" ")} ELSE false END AS allowed FROM input i${joinSql} ORDER BY i.ordinal`,
    values: builder.values,
  });
}

function compileBatchBranch(
  model: AuthorizationModelDefinition,
  cycles: PermissionCyclePlan,
  builder: QueryBuilder,
  namespaceSql: string,
  identity: string,
  shared: string[],
  joins: string[],
): string {
  const [resourceType, permission] = splitIdentity(identity);
  if (readLinearPath(model, resourceType, permission) !== undefined) {
    const branch = compileLinearBatchBranch(model, builder, {
      namespace: namespaceSql,
      resourceType,
      permission,
      index: shared.length,
    });
    shared.push(branch.hits);
    joins.push(branch.join);
    return branch.decision;
  }
  const context: ForwardContext = {
    model,
    cycles,
    builder,
    namespace: namespaceSql,
    subject: {
      type: "i.subject_kind",
      id: "i.subject_id",
      entity: resourceType,
    },
    active: new Set(),
  };
  const expression = compileForwardPermission(
    context,
    { type: "i.resource_kind", id: "i.resource_id", entity: resourceType },
    permission,
  );
  return `WHEN i.resource_kind = ${builder.value(resourceType)} AND i.permission = ${builder.value(permission)} THEN (${expression})`;
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
  options?: { readonly idColumn?: string; readonly paramOffset?: number },
): CompiledAuthorizationQuery {
  const builder = new QueryBuilder(options?.paramOffset ?? 1);
  const context = createForwardContext(model, builder, namespace, {
    type: builder.value(request.subject.type),
    id: builder.value(request.subject.id),
    entity: request.subject.type,
  });
  const idColumn =
    options?.idColumn ??
    `${POSTGRES_AUTHORIZATION_CANDIDATE_BINDING.tableAlias}.${POSTGRES_AUTHORIZATION_CANDIDATE_BINDING.resourceIdColumn}`;
  const expression = compileForwardPermission(
    context,
    {
      type: builder.value(request.resourceType),
      id: idColumn,
      entity: request.resourceType,
    },
    request.permission,
  );
  return Object.freeze({
    kind: "candidate-predicate",
    text: `(${expression})`,
    values: builder.values,
  });
}

function createForwardContext(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  namespace: string,
  subject: SqlReference,
): ForwardContext {
  return {
    model,
    cycles: analyzePermissionCycles(model),
    builder,
    namespace: builder.value(namespace),
    subject,
    active: new Set(),
  };
}

function compileForwardPermission(
  context: ForwardContext,
  resource: SqlReference,
  permissionName: string,
): string {
  const definition = context.model.permissions.find(
    (candidate) =>
      candidate.wireName === permissionName &&
      candidate.entity === resource.entity,
  );
  if (!definition)
    throw new Error(
      `Postgres policy cannot find permission ${permissionName}.`,
    );
  const scc = context.cycles.sccFor(resource.entity, permissionName);
  if (scc !== undefined) {
    return compileRecursiveForwardCheck({
      builder: context.builder,
      namespace: context.namespace,
      resource,
      entryEntity: resource.entity,
      entryPermission: permissionName,
      scc,
      compileExpression: (nodeResource, expression) =>
        compileForwardExpression(context, nodeResource, expression),
    });
  }
  const identity = permissionIdentity(resource.entity, permissionName);
  if (context.active.has(identity))
    throw new Error(
      "Postgres SQL compilation does not support a cycle through permissions.",
    );
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
      context.namespace,
      context.subject.type,
      context.subject.id,
      resource.entity,
      resource.type,
      resource.id,
      expression.relation,
      context.builder.value(expression.relation),
    );
  }
  if (expression.kind === "through")
    return compileThrough(context, resource, expression);
  if (expression.kind === "through-all")
    return compileThroughAll(context, resource, expression);
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
  const { builder, namespace } = context;
  const targets = resolveArrowTargets(
    context.model,
    resource.entity,
    expression,
  );
  const polymorphic = isPolymorphicRelation(
    context.model,
    resource.entity,
    expression.relation,
  );
  const relationSql = builder.value(expression.relation);
  const throughAlias = builder.throughAlias();
  const branchSql = compileArrowTargetBranches(
    context,
    throughAlias,
    targets,
    polymorphic,
  );
  // OFFSET 0 keeps each arrow a correlated subplan. Pulling arrows up
  // into semijoins can repeatedly execute the nested membership query.
  return `EXISTS (SELECT 1 FROM ${TUPLES} ${throughAlias} WHERE ${throughAlias}.namespace = ${namespace} AND ${throughAlias}.resource_kind = ${resource.type} AND ${throughAlias}.resource_id = ${resource.id} AND ${throughAlias}.relation = ${relationSql} AND ${throughAlias}.subject_is_wildcard = false AND ${throughAlias}.subject_relation = '' AND ${notExpired(throughAlias)} AND (${branchSql}) OFFSET 0)`;
}

function compileThroughAll(
  context: ForwardContext,
  resource: SqlReference,
  expression: Extract<CompiledPermissionExpression, { kind: "through-all" }>,
): string {
  const { builder, namespace } = context;
  const targets = resolveArrowTargets(
    context.model,
    resource.entity,
    expression,
  );
  const polymorphic = isPolymorphicRelation(
    context.model,
    resource.entity,
    expression.relation,
  );
  const relationSql = builder.value(expression.relation);
  const existsAlias = builder.throughAlias();
  const checkAlias = builder.throughAlias();
  const branchSql = compileArrowTargetBranches(
    context,
    checkAlias,
    targets,
    polymorphic,
  );
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
