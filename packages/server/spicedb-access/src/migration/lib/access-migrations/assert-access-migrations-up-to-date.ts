import type { DefinedAccessMigration } from "./define-access-migration.js";
import {
  assertNamespace,
  assertSqlIdentifier,
  assertUniqueMigrationIds,
  DEFAULT_MIGRATIONS_TABLE,
  readStringField,
  toSqliteMigrationExecutor,
  type PgMigrationExecutor,
  type SqliteMigrationExecutor,
  type SqliteSyncDatabaseLike,
} from "./sql-migration-types.js";

export type AccessMigrationRef = DefinedAccessMigration | string;

export type AssertAccessMigrationsUpToDateOptions =
  | {
      readonly dialect: "postgres";
      readonly executor: PgMigrationExecutor;
      readonly namespace: string;
      readonly migrations: readonly AccessMigrationRef[];
      readonly migrationsTable?: string;
    }
  | {
      readonly dialect: "sqlite";
      readonly executor: SqliteMigrationExecutor | SqliteSyncDatabaseLike;
      readonly namespace: string;
      readonly migrations: readonly AccessMigrationRef[];
      readonly migrationsTable?: string;
    };

export type AssertAccessMigrationsResult = {
  readonly applied: readonly string[];
};

/**
 * Verify that every declared access migration ID has been applied in the
 * backing SQL database. Throws an actionable error naming every missing ID
 * when the database is behind.
 */
export async function assertAccessMigrationsUpToDate(
  options: AssertAccessMigrationsUpToDateOptions,
): Promise<AssertAccessMigrationsResult> {
  const namespace = assertNamespace(options.namespace);
  const migrationsTable = assertSqlIdentifier(
    options.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE,
    "migrationsTable",
  );
  const declaredIds = options.migrations.map((entry) =>
    typeof entry === "string" ? entry : entry.id,
  );
  assertUniqueMigrationIds(declaredIds);

  const applied =
    options.dialect === "postgres"
      ? await readAppliedIdsFromPostgres(
          options.executor,
          migrationsTable,
          namespace,
        )
      : await readAppliedIdsFromSqlite(
          toSqliteMigrationExecutor(options.executor),
          migrationsTable,
          namespace,
        );

  const appliedSet = new Set(applied);
  const missing = declaredIds.filter((id) => !appliedSet.has(id));
  if (missing.length > 0) {
    const runner =
      options.dialect === "postgres"
        ? "runPostgresAccessMigrations"
        : "runSqliteAccessMigrations";
    throw new Error(
      `Access migrations for namespace "${namespace}" are behind by ${missing.length} migration(s): ${missing.join(", ")}. Run ${runner} before starting the application.`,
    );
  }
  return { applied };
}

async function readAppliedIdsFromPostgres(
  executor: PgMigrationExecutor,
  migrationsTable: string,
  namespace: string,
): Promise<readonly string[]> {
  try {
    const result = await executor.query(
      `SELECT id FROM ${migrationsTable} WHERE namespace = $1 ORDER BY id`,
      [namespace],
    );
    return result.rows.map((row) => readStringField(row, "id"));
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

async function readAppliedIdsFromSqlite(
  executor: SqliteMigrationExecutor,
  migrationsTable: string,
  namespace: string,
): Promise<readonly string[]> {
  try {
    const rows = await executor.all(
      `SELECT id FROM ${migrationsTable} WHERE namespace = ? ORDER BY id`,
      [namespace],
    );
    return rows.map((row) => readStringField(row, "id"));
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingTableError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "42P01") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no such table/i.test(message) ||
    /relation .+ does not exist/i.test(message)
  );
}
