import type { SubjectRef } from "@dads-framework/access/runtime";

import type { SqliteValue } from "../sqlite-types.js";
import { compileSqliteLookupSubquery } from "./compile-lookup-resources.js";
import type {
  SqliteAuthorizationModel,
  SqliteResourceLookup,
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
 * Uses a single actor-first semi-join (`idColumn IN (...)`) backed by
 * `dad_authorization_relationship_subject_lookup` so SQLite avoids scanning
 * every candidate row via correlated `EXISTS (...) OR EXISTS (...)` predicates.
 */
export function compileSqliteFilter(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  request: SqliteResourceLookup,
  idColumn: string,
): SqliteAccessFilter {
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
