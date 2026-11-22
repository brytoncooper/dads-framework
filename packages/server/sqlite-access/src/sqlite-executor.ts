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

const MAX_CACHED_STATEMENTS = 128;

/** Wrap a Node built-in `DatabaseSync` (or compatible sync database such as `better-sqlite3`). */
export function createNodeSqliteExecutor(
  database: DatabaseSync | SqliteDatabaseLike,
): SqliteExecutor {
  const cache = new Map<string, SqliteStatement>();
  const prepared = (sql: string): SqliteStatement => {
    const existing = cache.get(sql);
    if (existing !== undefined) {
      // Refresh recency for bounded LRU eviction.
      cache.delete(sql);
      cache.set(sql, existing);
      return existing;
    }
    const stmt = database.prepare(sql);
    if (cache.size >= MAX_CACHED_STATEMENTS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(sql, stmt);
    return stmt;
  };
  return {
    all(sql, params = []) {
      return prepared(sql).all(...params);
    },
    run(sql, params = []) {
      const result = prepared(sql).run(...params);
      return { changes: result.changes };
    },
    exec(sql) {
      database.exec(sql);
    },
  };
}
