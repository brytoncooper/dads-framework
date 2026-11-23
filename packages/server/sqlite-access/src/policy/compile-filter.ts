import type { PermissionToken } from "@dads-framework/access";
import type { SubjectRef } from "@dads-framework/access/runtime";

import type { SqliteValue } from "../sqlite-types.js";
import { deriveAutoSqliteScopeColumns } from "./column-relations.js";
import { compileSqliteExpressionSubquery, compileSqliteLookupSubquery } from "./compile-lookup-resources.js";
import {
  permissionKey,
  type SqliteAuthorizationModel,
  type SqlitePermissionExpression,
  type SqliteResourceLookup,
} from "./policy-model.js";
import { joinChunks } from "./policy-sql.js";

const SQL_ID_COLUMN_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

export type SqliteAccessFilter = {
  readonly sql: string;
  readonly values: readonly SqliteValue[];
};

type SqliteFilterQueryCommon = {
  readonly subject: SubjectRef;
  readonly idColumn: string;
  /**
   * Optional mapping from parent relation wire name to foreign-key column on
   * the queried table (e.g. `{ workspace: "d.workspace_id" }`), or `"auto"` to
   * derive mappings automatically from `columnRelations` on `resourceType`.
   * Lets `compileFilter` resolve scope permissions directly at the parent level
   * instead of expanding every child tuple on broad lists.
   */
  readonly scopeColumns?: Readonly<Record<string, string>> | "auto";
  /** Optional timestamp override (defaults to `this.#now()`). */
  readonly now?: Date;
};

export type SqliteFilterQuery =
  | (SqliteFilterQueryCommon & {
      readonly permission: string;
      readonly resourceType: string;
    })
  | (SqliteFilterQueryCommon & {
      readonly permission: PermissionToken;
    });

export function resolveSqliteFilterTarget(query: SqliteFilterQuery): {
  readonly resourceType: string;
  readonly permission: string;
} {
  if ("resourceType" in query) {
    return { resourceType: query.resourceType, permission: query.permission };
  }
  return {
    resourceType: query.permission.entityWireName,
    permission: query.permission.permissionName,
  };
}

export type ValidatedSqliteFilterInput = {
  readonly idColumn: string;
  readonly nowMs: number;
  readonly scopeColumns: Readonly<Record<string, string>> | undefined;
};

/** Validates `idColumn`, optional `scopeColumns`, and optional `now` override before SQL compilation. */
export function validateSqliteFilterQuery(
  query: SqliteFilterQueryCommon & { readonly resourceType: string },
  defaultNowMs: number,
  model?: SqliteAuthorizationModel,
): ValidatedSqliteFilterInput {
  if (!SQL_ID_COLUMN_PATTERN.test(query.idColumn)) {
    throw new Error(
      `Invalid SQLite filter idColumn "${query.idColumn}": must be an unquoted identifier or table.column`,
    );
  }
  const scopeColumns =
    query.scopeColumns === "auto"
      ? model === undefined
        ? undefined
        : deriveAutoSqliteScopeColumns(model, query.resourceType, query.idColumn)
      : validateScopeColumns(query.scopeColumns);
  if (query.now !== undefined) {
    const nowMs = query.now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("SQLite filter now must be a valid Date");
    }
    return { idColumn: query.idColumn, nowMs, scopeColumns };
  }
  return { idColumn: query.idColumn, nowMs: defaultNowMs, scopeColumns };
}

function validateScopeColumns(
  scopeColumns: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (scopeColumns === undefined) return undefined;
  const entries = Object.entries(scopeColumns);
  if (entries.length === 0) return undefined;
  for (const [relation, column] of entries) {
    if (!SQL_ID_COLUMN_PATTERN.test(column)) {
      throw new Error(
        `Invalid SQLite filter scopeColumns["${relation}"] "${column}": must be an unquoted identifier or table.column`,
      );
    }
  }
  return scopeColumns;
}

/**
 * Compiles one permission into a self-contained SQLite Boolean predicate for
 * embedding inside an application `WHERE (...)` clause.
 */
export function compileSqliteFilter(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  request: SqliteResourceLookup,
  idColumn: string,
  scopeColumns?: Readonly<Record<string, string>>,
): SqliteAccessFilter {
  if (scopeColumns !== undefined) {
    const def = model.permissionByKey.get(permissionKey(request.resourceType, request.permission));
    if (def !== undefined) {
      const scoped = tryCompileScopedSqliteExpression(
        { model, namespace, nowMs, request, idColumn, scopeColumns },
        def.expression,
      );
      if (scoped !== undefined) return scoped;
    }
  }
  const subquery = compileSqliteLookupSubquery(model, namespace, nowMs, request, { deduplicate: false });
  return Object.freeze({
    sql: `(${idColumn} IN (${subquery.sql}))`,
    values: subquery.params,
  });
}

type SqliteScopedContext = {
  readonly model: SqliteAuthorizationModel;
  readonly namespace: string;
  readonly nowMs: number;
  readonly request: SqliteResourceLookup;
  readonly idColumn: string;
  readonly scopeColumns: Readonly<Record<string, string>>;
};

function tryCompileScopedSqliteExpression(
  ctx: SqliteScopedContext,
  expression: SqlitePermissionExpression,
): SqliteAccessFilter | undefined {
  if (expression.kind === "exclude") {
    const inc = tryCompileScopedSqliteExpression(ctx, expression.include);
    if (inc === undefined) return undefined;
    const exc = compileSqliteExpressionSubquery(
      ctx.model,
      ctx.namespace,
      ctx.nowMs,
      ctx.request.subject,
      ctx.request.resourceType,
      expression.exclude,
      { deduplicate: false },
    );
    return Object.freeze({
      sql: `(${inc.sql} AND ${ctx.idColumn} NOT IN (${exc.sql}))`,
      values: [...inc.values, ...exc.params],
    });
  }
  if (expression.kind === "through") {
    const column = ctx.scopeColumns[expression.relation];
    const target = expression.targets.length === 1 ? expression.targets[0] : undefined;
    if (column === undefined || target === undefined) return undefined;
    const sub = compileSqliteLookupSubquery(
      ctx.model,
      ctx.namespace,
      ctx.nowMs,
      {
        subject: ctx.request.subject,
        resourceType: target.entity,
        permission: target.permission,
      },
      { deduplicate: false },
    );
    return Object.freeze({
      sql: `(${column} IN (${sub.sql}))`,
      values: sub.params,
    });
  }
  if (expression.kind !== "any-of") return undefined;
  return tryCompileScopedSqliteAnyOf(ctx, expression.expressions);
}

function tryCompileScopedSqliteAnyOf(
  ctx: SqliteScopedContext,
  expressions: readonly SqlitePermissionExpression[],
): SqliteAccessFilter | undefined {
  const scopedChunks: {
    readonly sql: string;
    readonly params: readonly SqliteValue[];
  }[] = [];
  const remainder: SqlitePermissionExpression[] = [];
  for (const child of expressions) {
    const scopedChild = tryCompileScopedSqliteExpression(ctx, child);
    if (scopedChild !== undefined) {
      scopedChunks.push({ sql: scopedChild.sql, params: scopedChild.values });
    } else {
      remainder.push(child);
    }
  }
  if (scopedChunks.length === 0) return undefined;
  if (remainder.length > 0) {
    const restExpr: SqlitePermissionExpression =
      remainder.length === 1 && remainder[0] !== undefined ? remainder[0] : { kind: "any-of", expressions: remainder };
    const sub = compileSqliteExpressionSubquery(
      ctx.model,
      ctx.namespace,
      ctx.nowMs,
      ctx.request.subject,
      ctx.request.resourceType,
      restExpr,
      { deduplicate: false },
    );
    scopedChunks.push({
      sql: `(${ctx.idColumn} IN (${sub.sql}))`,
      params: sub.params,
    });
  }
  const combined = joinChunks(scopedChunks, " OR ");
  return Object.freeze({
    sql: `(${combined.sql})`,
    values: combined.params,
  });
}
