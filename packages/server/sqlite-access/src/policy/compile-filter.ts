import type { SubjectRef } from "@dads-framework/access/runtime";

import type { SqliteValue } from "../sqlite-types.js";
import {
  columnChunk,
  compileForwardPermission,
  literalChunk,
  type ForwardCompileContext,
} from "./compile-check.js";
import { compileSqliteLookupSubquery } from "./compile-lookup-resources.js";
import {
  permissionKey,
  type SqliteAuthorizationModel,
  type SqlitePermissionExpression,
  type SqliteResourceLookup,
} from "./policy-model.js";

const SQL_ID_COLUMN_PATTERN =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

export type SqliteAccessFilter = {
  readonly sql: string;
  readonly values: readonly SqliteValue[];
};

export type SqliteFilterQuery = {
  readonly subject: SubjectRef;
  readonly permission: string;
  readonly resourceType: string;
  readonly idColumn: string;
  /** Optional timestamp override (defaults to `this.#now()`). */
  readonly now?: Date;
};

/** Validates `idColumn` and optional `now` override before SQL compilation. */
export function validateSqliteFilterQuery(
  query: Pick<SqliteFilterQuery, "idColumn" | "now">,
  defaultNowMs: number,
): { readonly idColumn: string; readonly nowMs: number } {
  if (!SQL_ID_COLUMN_PATTERN.test(query.idColumn)) {
    throw new Error(
      `Invalid SQLite filter idColumn "${query.idColumn}": must be an unquoted identifier or table.column`,
    );
  }
  if (query.now !== undefined) {
    const nowMs = query.now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("SQLite filter now must be a valid Date");
    }
    return { idColumn: query.idColumn, nowMs };
  }
  return { idColumn: query.idColumn, nowMs: defaultNowMs };
}

/**
 * Compiles one permission into a self-contained SQLite Boolean predicate for
 * embedding inside an application `WHERE (...)` clause.
 *
 * Acyclic rules compile to correlated `EXISTS` predicates; rules reaching a
 * recursive permission cycle compile to `(idColumn IN (WITH RECURSIVE ...))`.
 */
export function compileSqliteFilter(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  request: SqliteResourceLookup,
  idColumn: string,
): SqliteAccessFilter {
  if (
    permissionInvolvesCycle(model, request.resourceType, request.permission)
  ) {
    const subquery = compileSqliteLookupSubquery(
      model,
      namespace,
      nowMs,
      request,
    );
    return Object.freeze({
      sql: `(${idColumn} IN (${subquery.sql}))`,
      values: subquery.params,
    });
  }
  let aliasCount = 0;
  const context: ForwardCompileContext = {
    model,
    namespace,
    nowMs,
    nextAlias: (prefix) => `${prefix}_${aliasCount++}`,
  };
  const predicate = compileForwardPermission(
    context,
    {
      kind: "concrete",
      typeExpr: literalChunk(request.subject.type),
      idExpr: literalChunk(request.subject.id),
    },
    {
      entity: request.resourceType,
      typeExpr: literalChunk(request.resourceType),
      idExpr: columnChunk(idColumn),
    },
    request.permission,
  );
  return Object.freeze({
    sql: `(${predicate.sql})`,
    values: predicate.params,
  });
}

function permissionInvolvesCycle(
  model: SqliteAuthorizationModel,
  entity: string,
  permissionName: string,
  visited: Set<string> = new Set(),
): boolean {
  const key = permissionKey(entity, permissionName);
  if (visited.has(key)) return false;
  visited.add(key);
  if (model.cyclicSccsByKey.has(key)) return true;
  const definition = model.permissionByKey.get(key);
  if (definition === undefined) return false;
  return expressionInvolvesCycle(model, definition.expression, visited);
}

function expressionInvolvesCycle(
  model: SqliteAuthorizationModel,
  expression: SqlitePermissionExpression,
  visited: Set<string>,
): boolean {
  if (expression.kind === "relation") return false;
  if (expression.kind === "through" || expression.kind === "through-all") {
    return expression.targets.some((target) =>
      permissionInvolvesCycle(model, target.entity, target.permission, visited),
    );
  }
  if (expression.kind === "exclude") {
    return (
      expressionInvolvesCycle(model, expression.include, visited) ||
      expressionInvolvesCycle(model, expression.exclude, visited)
    );
  }
  return expression.expressions.some((child) =>
    expressionInvolvesCycle(model, child, visited),
  );
}
