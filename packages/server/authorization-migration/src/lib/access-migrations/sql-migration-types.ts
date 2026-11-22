export const DEFAULT_RELATIONSHIP_TABLE = "dad_authorization_relationship";
export const DEFAULT_MIGRATIONS_TABLE = "dads_access_migrations";

const SQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/i;

export type PgMigrationRow = Readonly<Record<string, unknown>>;

export type PgMigrationQueryResult = {
  readonly rows: readonly PgMigrationRow[];
};

/**
 * Minimal structural Postgres client accepted from `pg.PoolClient` or `pg.Pool`.
 * Values remain a mutable array so `pg`'s `query(text, values?)` matches directly.
 */
export type PgMigrationClient = {
  query(text: string, values?: unknown[]): Promise<PgMigrationQueryResult>;
};

export type PgMigrationPoolClient = PgMigrationClient & {
  release(): void;
};

/**
 * Structural Postgres executor: accepts a `pg.Pool` (with `connect()`) or a
 * single `pg.PoolClient` / custom executor with `query(...)`.
 */
export type PgMigrationExecutor = PgMigrationClient & {
  connect?: () => Promise<PgMigrationPoolClient>;
};

export type SqliteMigrationValue = string | number | bigint | Uint8Array | null;
export type SqliteMigrationRow = Readonly<Record<string, unknown>>;

/** Structural SQLite executor compatible with `node:sqlite`, `better-sqlite3`, and async wrappers. */
export type SqliteMigrationExecutor = {
  all(
    sql: string,
    params?: readonly SqliteMigrationValue[],
  ): PromiseLike<readonly SqliteMigrationRow[]> | readonly SqliteMigrationRow[];
  run(sql: string, params?: readonly SqliteMigrationValue[]): unknown;
  exec(sql: string): PromiseLike<void> | void;
};

export type SqliteSyncStatementLike = {
  all(...params: SqliteMigrationValue[]): readonly SqliteMigrationRow[];
  run(...params: SqliteMigrationValue[]): unknown;
};

/** Structural synchronous SQLite handle satisfied by Node's built-in `DatabaseSync`. */
export type SqliteSyncDatabaseLike = {
  prepare(sql: string): SqliteSyncStatementLike;
  exec(sql: string): void;
};

export type AccessMigrationRunResult = {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
};

export function createSqliteMigrationExecutor(
  database: SqliteSyncDatabaseLike,
): SqliteMigrationExecutor {
  return {
    all(sql, params = []) {
      return database.prepare(sql).all(...params);
    },
    run(sql, params = []) {
      return database.prepare(sql).run(...params);
    },
    exec(sql) {
      database.exec(sql);
    },
  };
}

export function toSqliteMigrationExecutor(
  input: SqliteMigrationExecutor | SqliteSyncDatabaseLike,
): SqliteMigrationExecutor {
  if ("prepare" in input) {
    return createSqliteMigrationExecutor(input);
  }
  return input;
}

export function assertSqlIdentifier(name: string, label: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Invalid SQL identifier for ${label}: "${name}". Expected letters, digits, and underscores.`,
    );
  }
  return name;
}

export function assertNamespace(namespace: string): string {
  if (namespace.trim() === "") {
    throw new Error("Access migration namespace must be a non-empty string");
  }
  return namespace;
}

export function assertUniqueMigrationIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate access migration id "${id}"`);
    }
    seen.add(id);
  }
}

export function readStringField(
  row: Readonly<Record<string, unknown>>,
  column: string,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Expected string column "${column}" in migration query`);
  }
  return value;
}
