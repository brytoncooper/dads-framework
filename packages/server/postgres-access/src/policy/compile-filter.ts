import type { SubjectRef } from "@dads-framework/access/runtime";

import type {
  AuthorizationModelDefinition,
  CompiledPermissionExpression,
  NormalizedResourceLookup,
} from "./policy-model.js";
import { compilePostgresCandidatePredicate } from "./compile-postgres-policy.js";
import { compileReversePermission } from "./compile-reverse-policy.js";
import {
  analyzePermissionCycles,
  type PermissionCyclePlan,
} from "./permission-cycles.js";
import {
  permissionIdentity,
  QueryBuilder,
  resolveArrowTargets,
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
 * Acyclic rules compile to correlated `EXISTS` predicates; rules reaching a
 * recursive permission cycle compile to `(idColumn IN (WITH RECURSIVE ...))`.
 */
export function compilePostgresFilter(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedResourceLookup,
  options: ValidatedPostgresFilterInput,
): PostgresAccessFilter {
  const cycles = analyzePermissionCycles(model);
  if (
    permissionInvolvesCycle(
      model,
      cycles,
      request.resourceType,
      request.permission,
    )
  ) {
    return compileRecursiveFilter(model, namespace, request, options);
  }
  const compiled = compilePostgresCandidatePredicate(
    model,
    namespace,
    request,
    options,
  );
  return Object.freeze({
    sql: compiled.text,
    values: compiled.values ?? [],
  });
}

function compileRecursiveFilter(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedResourceLookup,
  options: ValidatedPostgresFilterInput,
): PostgresAccessFilter {
  const builder = new QueryBuilder(options.paramOffset);
  const namespaceSql = builder.value(namespace);
  const subjectTypeSql = builder.value(request.subject.type);
  const subjectIdSql = builder.value(request.subject.id);
  const allowedResourceIds = compileReversePermission(
    model,
    builder,
    namespaceSql,
    request.resourceType,
    request.permission,
    new Set(),
  );
  return Object.freeze({
    sql: `(${options.idColumn} IN (WITH RECURSIVE ${subjectReachability(namespaceSql, subjectTypeSql, subjectIdSql)} SELECT DISTINCT allowed_resource.resource_id FROM (${allowedResourceIds}) allowed_resource))`,
    values: builder.values,
  });
}

function permissionInvolvesCycle(
  model: AuthorizationModelDefinition,
  cycles: PermissionCyclePlan,
  entity: string,
  permissionName: string,
  visited: Set<string> = new Set(),
): boolean {
  const identity = permissionIdentity(entity, permissionName);
  if (visited.has(identity)) return false;
  visited.add(identity);
  if (cycles.sccFor(entity, permissionName) !== undefined) return true;
  const definition = model.permissions.find(
    (candidate) =>
      candidate.wireName === permissionName && candidate.entity === entity,
  );
  if (definition === undefined) return false;
  return expressionInvolvesCycle(
    model,
    cycles,
    entity,
    definition.expression,
    visited,
  );
}

function expressionInvolvesCycle(
  model: AuthorizationModelDefinition,
  cycles: PermissionCyclePlan,
  entity: string,
  expression: CompiledPermissionExpression,
  visited: Set<string>,
): boolean {
  if (expression.kind === "relation") return false;
  if (expression.kind === "through" || expression.kind === "through-all") {
    return resolveArrowTargets(model, entity, expression).some((target) =>
      permissionInvolvesCycle(
        model,
        cycles,
        target.entity,
        target.permission,
        visited,
      ),
    );
  }
  if (expression.kind === "exclude") {
    return (
      expressionInvolvesCycle(
        model,
        cycles,
        entity,
        expression.include,
        visited,
      ) ||
      expressionInvolvesCycle(
        model,
        cycles,
        entity,
        expression.exclude,
        visited,
      )
    );
  }
  return expression.expressions.some((child) =>
    expressionInvolvesCycle(model, cycles, entity, child, visited),
  );
}
