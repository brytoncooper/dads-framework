import type {
  AuthorizationModelDefinition,
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
import {
  compileForwardPermission,
  countRecursiveClauses,
  createForwardContext,
  type ForwardContext,
  type SqlReference,
} from "./compile-forward-policy.js";
import {
  permissionIdentity,
  QueryBuilder,
  splitIdentity,
  subjectReachability,
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
  if (
    Buffer.byteLength(expression) > 16 * 1024 ||
    countRecursiveClauses(expression) > 6
  )
    return compileSharedPointCheck(model, namespace, request);
  return Object.freeze({
    kind: "check",
    text: `SELECT (${expression}) AS allowed`,
    values: builder.values,
    // Prepare bounded ordinary and recursive single-check plans so PostgreSQL
    // reuses compiled execution plans across repeated checks.
    canPrepare: builder.hasRecursive
      ? builder.values.length <= 24 && builder.throughCount <= 2
      : builder.values.length <= 9 && builder.throughCount <= 2,
  });
}

/** One ordinal input relation and one SQL statement preserve input ordering and duplicates. */
export function compilePostgresCheckMany(
  model: AuthorizationModelDefinition,
  namespace: string,
  requests: readonly NormalizedPermissionCheck[],
): CompiledAuthorizationQuery & { readonly canPrepare: boolean } {
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
  const text = `WITH input(ordinal, subject_kind, subject_id, resource_kind, resource_id, permission) AS (${inputRows})${shared.map((query) => `, ${query}`).join("")} SELECT i.ordinal AS ordinal, CASE ${branches.join(" ")} ELSE false END AS allowed FROM input i${joinSql} ORDER BY i.ordinal`;
  return Object.freeze({
    kind: "check-many",
    text,
    values: builder.values,
    canPrepare: identities.length <= 4 && Buffer.byteLength(text) <= 8 * 1024,
  });
}

function shouldUseSharedBatchBranch(
  model: AuthorizationModelDefinition,
  cycles: PermissionCyclePlan,
  namespaceSql: string,
  resourceType: string,
  permission: string,
): boolean {
  if (readLinearPath(model, resourceType, permission) !== undefined) {
    return true;
  }
  const probeBuilder = new QueryBuilder();
  const probeContext: ForwardContext = {
    model,
    cycles,
    builder: probeBuilder,
    namespace: namespaceSql,
    subject: {
      type: "i.subject_kind",
      id: "i.subject_id",
      entity: resourceType,
    },
    active: new Set(),
  };
  const probeSql = compileForwardPermission(
    probeContext,
    { type: "i.resource_kind", id: "i.resource_id", entity: resourceType },
    permission,
  );
  return (
    Buffer.byteLength(probeSql) > 16 * 1024 ||
    countRecursiveClauses(probeSql) > 6
  );
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
  if (
    shouldUseSharedBatchBranch(
      model,
      cycles,
      namespaceSql,
      resourceType,
      permission,
    )
  ) {
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
    text: `WITH RECURSIVE ${subjectReachability(namespaceSql, subject.type, subject.id, model.columnRelations, builder)} SELECT DISTINCT allowed_resource.resource_id FROM (${allowedResourceIds}) allowed_resource ORDER BY allowed_resource.resource_id`,
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
