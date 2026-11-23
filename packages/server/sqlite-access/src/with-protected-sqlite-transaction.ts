import type { SqliteAuthorization } from "./sqlite-authorization.js";
import type { SqliteExecutor } from "./sqlite-executor.js";

type ScopeLifetime = {
  active(): boolean;
};

const activeScopes = new WeakMap<SqliteAuthorization, ScopeLifetime>();

export type ProtectedSqliteTransactionOptions = {
  readonly executor: SqliteExecutor;
  readonly authorization: SqliteAuthorization;
  readonly now?: () => Date;
};

export type ProtectedSqliteTransaction = {
  readonly executor: SqliteExecutor;
  readonly authorization: SqliteAuthorization;
};

/**
 * Run one protected write inside a SQLite `BEGIN IMMEDIATE` transaction with a
 * single pinned `nowMs` snapshot and a scoped authorization handle that expires
 * as soon as the callback returns or throws.
 */
export async function withProtectedSqliteTransaction<Result>(
  options: ProtectedSqliteTransactionOptions,
  work: (scope: ProtectedSqliteTransaction) => Promise<Result>,
): Promise<Result> {
  assertActiveScope(options.authorization);
  const pinnedMs = resolvePinnedTimestamp(options);
  const parent = activeScopes.get(options.authorization);

  let open = true;
  const isActive = (): boolean => open && (parent?.active() ?? true);
  const scopedExecutor = createScopedExecutor(options.executor, isActive);
  const txAuth = options.authorization.inTransaction(scopedExecutor, () => new Date(pinnedMs));
  activeScopes.set(txAuth, { active: isActive });

  await options.executor.exec("BEGIN IMMEDIATE");
  try {
    const result = await work({
      executor: scopedExecutor,
      authorization: txAuth,
    });
    open = false;
    await options.executor.exec("COMMIT");
    return result;
  } catch (error) {
    open = false;
    await safeRollback(options.executor);
    throw error;
  }
}

function assertActiveScope(authorization: SqliteAuthorization): void {
  const scope = activeScopes.get(authorization);
  if (scope !== undefined && !scope.active()) {
    throw scopeEndedError();
  }
}

function resolvePinnedTimestamp(options: ProtectedSqliteTransactionOptions): number {
  const ms = options.now !== undefined ? options.now().getTime() : options.authorization.currentTimeMs();
  if (!Number.isFinite(ms)) {
    throw new Error("Protected SQLite transaction clock must return a valid Date");
  }
  return ms;
}

function createScopedExecutor(inner: SqliteExecutor, isActive: () => boolean): SqliteExecutor {
  return {
    all(sql, params) {
      if (!isActive()) return Promise.reject(scopeEndedError());
      return inner.all(sql, params);
    },
    run(sql, params) {
      if (!isActive()) return Promise.reject(scopeEndedError());
      return inner.run(sql, params);
    },
    exec(sql) {
      if (!isActive()) return Promise.reject(scopeEndedError());
      return inner.exec(sql);
    },
  };
}

async function safeRollback(executor: SqliteExecutor): Promise<void> {
  try {
    await executor.exec("ROLLBACK");
  } catch {
    // SQLite may have already rolled back automatically on constraint/IO error.
  }
}

function scopeEndedError(): Error {
  return new Error("Protected SQLite authorization scope has ended");
}
