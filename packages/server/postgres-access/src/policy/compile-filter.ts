import type { SubjectRef } from "@dads-framework/access/runtime";

import type {
  AuthorizationModelDefinition,
  CompiledPermissionExpression,
  NormalizedResourceLookup,
} from "./policy-model.js";
import {
  compileReverseExpressionQuery,
  compileReversePermission,
} from "./compile-reverse-policy.js";
import {
  directSubjectReachability,
  modelHasUsersetTargets,
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
  /**
   * Optional mapping from parent relation wire name to foreign-key column on
   * the queried table (e.g. `{ workspace: "d.workspace_id" }`). Lets
   * `compileFilter` resolve scope permissions directly at the parent level
   * instead of expanding every child tuple on broad lists.
   */
  readonly scopeColumns?: Readonly<Record<string, string>>;
  /** Starting `$N` placeholder index (default `1`) so callers can embed after existing `$1..$k` params. */
  readonly paramOffset?: number;
};

export type ValidatedPostgresFilterInput = {
  readonly idColumn: string;
  readonly paramOffset: number;
  readonly scopeColumns: Readonly<Record<string, string>> | undefined;
};

/** Validates `idColumn`, optional `scopeColumns`, and `paramOffset` before SQL compilation. */
export function validatePostgresFilterQuery(
  query: Pick<PostgresFilterQuery, "idColumn" | "scopeColumns" | "paramOffset">,
): ValidatedPostgresFilterInput {
  if (!SQL_ID_COLUMN_PATTERN.test(query.idColumn)) {
    throw new Error(
      `Invalid Postgres filter idColumn "${query.idColumn}": must be an unquoted identifier or table.column`,
    );
  }
  const scopeColumns = validatePgScopeColumns(query.scopeColumns);
  const paramOffset = query.paramOffset ?? 1;
  if (!Number.isSafeInteger(paramOffset) || paramOffset < 1) {
    throw new Error(
      "Postgres filter paramOffset must be a positive safe integer",
    );
  }
  return { idColumn: query.idColumn, paramOffset, scopeColumns };
}

function validatePgScopeColumns(
  scopeColumns: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (scopeColumns === undefined) return undefined;
  const entries = Object.entries(scopeColumns);
  if (entries.length === 0) return undefined;
  for (const [relation, column] of entries) {
    if (!SQL_ID_COLUMN_PATTERN.test(column)) {
      throw new Error(
        `Invalid Postgres filter scopeColumns["${relation}"] "${column}": must be an unquoted identifier or table.column`,
      );
    }
  }
  return scopeColumns;
}

/**
 * Compiles one permission into a self-contained SQL Boolean predicate for
 * embedding inside an application `WHERE (...)` clause.
 *
 * Uses pullable actor-first semi-joins backed by the covering
 * `dad_authorization_relationship_subject_lookup` index. When `scopeColumns`
 * is provided, parent-relation branches evaluate directly against the table's
 * foreign-key column so broad admin lists avoid expanding child tuples.
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

  const wrapSemiJoin = (
    column: string,
    innerSql: string,
    negated = false,
  ): string => {
    const withKeyword =
      usesUsersets || builder.hasRecursive ? "WITH RECURSIVE" : "WITH";
    const op = negated ? "NOT IN" : "IN";
    return `(${column} ${op} (${withKeyword} ${reachCte} SELECT allowed_resource.resource_id FROM (${innerSql}) allowed_resource))`;
  };

  if (options.scopeColumns !== undefined) {
    const definition = model.permissions.find(
      (candidate) =>
        candidate.entity === request.resourceType &&
        candidate.wireName === request.permission,
    );
    if (definition !== undefined) {
      const scopedSql = tryCompileScopedPostgresExpression(
        {
          model,
          builder,
          namespaceSql,
          entity: request.resourceType,
          idColumn: options.idColumn,
          scopeColumns: options.scopeColumns,
          wrapSemiJoin,
        },
        definition.expression,
      );
      if (scopedSql !== undefined) {
        return Object.freeze({ sql: scopedSql, values: builder.values });
      }
    }
  }

  const allowedResourceIds = compileReversePermission(
    model,
    builder,
    namespaceSql,
    request.resourceType,
    request.permission,
    new Set(),
    { deduplicate: false },
  );
  return Object.freeze({
    sql: wrapSemiJoin(options.idColumn, allowedResourceIds),
    values: builder.values,
  });
}

type PostgresScopedContext = {
  readonly model: AuthorizationModelDefinition;
  readonly builder: QueryBuilder;
  readonly namespaceSql: string;
  readonly entity: string;
  readonly idColumn: string;
  readonly scopeColumns: Readonly<Record<string, string>>;
  readonly wrapSemiJoin: (
    column: string,
    innerSql: string,
    negated?: boolean,
  ) => string;
};

function tryCompileScopedPostgresExpression(
  ctx: PostgresScopedContext,
  expression: CompiledPermissionExpression,
): string | undefined {
  if (expression.kind === "exclude") {
    const includeSql = tryCompileScopedPostgresExpression(
      ctx,
      expression.include,
    );
    if (includeSql === undefined) return undefined;
    const excludeIds = compileReverseExpressionQuery(
      ctx.model,
      ctx.builder,
      ctx.namespaceSql,
      ctx.entity,
      expression.exclude,
      new Set(),
      { deduplicate: false },
    );
    return `(${includeSql} AND ${ctx.wrapSemiJoin(ctx.idColumn, excludeIds, true)})`;
  }
  if (expression.kind === "through") {
    const column = ctx.scopeColumns[expression.relation];
    if (column === undefined) return undefined;
    const targets = resolveArrowTargets(ctx.model, ctx.entity, expression);
    const target = targets.length === 1 ? targets[0] : undefined;
    if (target === undefined) return undefined;
    const allowedScopes = compileReversePermission(
      ctx.model,
      ctx.builder,
      ctx.namespaceSql,
      target.entity,
      target.permission,
      new Set(),
      { deduplicate: false },
    );
    return ctx.wrapSemiJoin(column, allowedScopes);
  }
  if (expression.kind !== "any-of") return undefined;
  return tryCompileScopedPostgresAnyOf(ctx, expression.expressions);
}

function tryCompileScopedPostgresAnyOf(
  ctx: PostgresScopedContext,
  expressions: readonly CompiledPermissionExpression[],
): string | undefined {
  const scopedParts: string[] = [];
  const remainder: CompiledPermissionExpression[] = [];
  for (const child of expressions) {
    const part = tryCompileScopedPostgresExpression(ctx, child);
    if (part !== undefined) {
      scopedParts.push(part);
    } else {
      remainder.push(child);
    }
  }
  if (scopedParts.length === 0) return undefined;
  if (remainder.length > 0) {
    const restExpr: CompiledPermissionExpression =
      remainder.length === 1 && remainder[0] !== undefined
        ? remainder[0]
        : { kind: "any-of", expressions: remainder };
    const restIds = compileReverseExpressionQuery(
      ctx.model,
      ctx.builder,
      ctx.namespaceSql,
      ctx.entity,
      restExpr,
      new Set(),
      { deduplicate: false },
    );
    scopedParts.push(ctx.wrapSemiJoin(ctx.idColumn, restIds));
  }
  return `(${scopedParts.join(" OR ")})`;
}
