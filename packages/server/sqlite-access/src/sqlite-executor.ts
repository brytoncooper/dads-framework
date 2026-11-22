import type { DatabaseSync } from "node:sqlite";

import type {
  SqliteRow,
  SqliteRunResult,
  SqliteValue,
} from "./sqlite-types.js";

/** Minimal SQLite port implemented by Node SQLite, better-sqlite3, Drizzle, or libSQL wrappers. */
export type SqliteExecutor = {
  all(
    sql: string,
    params?: readonly SqliteValue[],
  ): PromiseLike<readonly SqliteRow[]> | readonly SqliteRow[];
  run(
    sql: string,
    params?: readonly SqliteValue[],
  ): PromiseLike<SqliteRunResult> | SqliteRunResult;
  exec(sql: string): PromiseLike<void> | void;
};

/** Structural prepared statement accepted from `node:sqlite` or `better-sqlite3`. */
export type SqliteStatement = {
  all(...params: readonly SqliteValue[]): readonly SqliteRow[];
  run(...params: readonly SqliteValue[]): SqliteRunResult;
};

/** Structural synchronous SQLite database accepted from `node:sqlite` or `better-sqlite3`. */
export type SqliteDatabaseLike = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
};

/** Wrap a Node built-in `DatabaseSync` (or compatible sync database such as `better-sqlite3`). */
export function createNodeSqliteExecutor(
  database: DatabaseSync | SqliteDatabaseLike,
): SqliteExecutor {
  return {
    all(sql, params = []) {
      return database.prepare(sql).all(...params);
    },
    run(sql, params = []) {
      const result = database.prepare(sql).run(...params);
      return { changes: result.changes };
    },
    exec(sql) {
      database.exec(sql);
    },
  };
}
