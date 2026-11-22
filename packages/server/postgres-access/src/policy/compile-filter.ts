import type { SubjectRef } from "@dads-framework/access/runtime";

import type {
  AuthorizationModelDefinition,
  NormalizedResourceLookup,
} from "./policy-model.js";
import { compileReversePermission } from "./compile-reverse-policy.js";
import {
  directSubjectReachability,
  modelHasUsersetTargets,
  QueryBuilder,
  subjectReachability,
} from "./policy-sql.js";

const SQL_ID_COLUMN_PATTERN =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

export type PostgresAccessFilter = {
  readonly sql: string;
  readonly values: readonly unknown[];
};

export type PostgresFilterQuery = {
  readonly subject: SubjectRef;
  readonly permission: string;
  readonly resourceType: string;
  /** SQL column/expression for the candidate resource ID, e.g. `"documents.id"` or `"id"`. */
  readonly idColumn: string;
  /** Starting `$N` placeholder index (default `1`) so callers can embed after existing `$1..$k` params. */
  readonly paramOffset?: number;
};

export type ValidatedPostgresFilterInput = {
  readonly idColumn: string;
  readonly paramOffset: number;
};

/** Validates `idColumn` and `paramOffset` before SQL compilation. */
export function validatePostgresFilterQuery(
  query: Pick<PostgresFilterQuery, "idColumn" | "paramOffset">,
): ValidatedPostgresFilterInput {
  if (!SQL_ID_COLUMN_PATTERN.test(query.idColumn)) {
    throw new Error(
      `Invalid Postgres filter idColumn "${query.idColumn}": must be an unquoted identifier or table.column`,
    );
  }
  const paramOffset = query.paramOffset ?? 1;
  if (!Number.isSafeInteger(paramOffset) || paramOffset < 1) {
    throw new Error(
      "Postgres filter paramOffset must be a positive safe integer",
    );
  }
  return { idColumn: query.idColumn, paramOffset };
}

/**
 * Compiles one permission into a self-contained SQL Boolean predicate for
 * embedding inside an application `WHERE (...)` clause.
 *
 * Uses a single pullable actor-first semi-join (`idColumn IN (...)`) backed by
 * `dad_authorization_relationship_subject_lookup` so PostgreSQL never falls
 * back to row-by-row correlated `EXISTS (...) OR EXISTS (...)` scans on large
 * tables, while still supporting recursive permissions, wildcards, exclusions,
 * and intersections.
 */
export function compilePostgresFilter(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedResourceLookup,
  options: ValidatedPostgresFilterInput,
): PostgresAccessFilter {
  const builder = new QueryBuilder(options.paramOffset);
  const namespaceSql = builder.value(namespace);
  const subjectTypeSql = builder.value(request.subject.type);
  const subjectIdSql = builder.value(request.subject.id);
  const usesUsersets = modelHasUsersetTargets(model);
  const reachCte = usesUsersets
    ? subjectReachability(namespaceSql, subjectTypeSql, subjectIdSql)
    : directSubjectReachability(namespaceSql, subjectTypeSql, subjectIdSql);
  const allowedResourceIds = compileReversePermission(
    model,
    builder,
    namespaceSql,
    request.resourceType,
    request.permission,
    new Set(),
    { deduplicate: false },
  );
  const withKeyword =
    usesUsersets || builder.hasRecursive ? "WITH RECURSIVE" : "WITH";
  return Object.freeze({
    sql: `(${options.idColumn} IN (${withKeyword} ${reachCte} SELECT allowed_resource.resource_id FROM (${allowedResourceIds}) allowed_resource))`,
    values: builder.values,
  });
}
