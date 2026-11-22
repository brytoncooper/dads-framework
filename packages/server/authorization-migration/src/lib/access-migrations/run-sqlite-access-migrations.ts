import type {
  AccessMigrationStepOp,
  DefinedAccessMigration,
} from "./define-access-migration.js";
import {
  assertNamespace,
  assertSqlIdentifier,
  assertUniqueMigrationIds,
  DEFAULT_MIGRATIONS_TABLE,
  DEFAULT_RELATIONSHIP_TABLE,
  readStringField,
  toSqliteMigrationExecutor,
  type AccessMigrationRunResult,
  type SqliteMigrationExecutor,
  type SqliteSyncDatabaseLike,
} from "./sql-migration-types.js";

export type RunSqliteAccessMigrationsOptions = {
  readonly executor: SqliteMigrationExecutor | SqliteSyncDatabaseLike;
  readonly namespace: string;
  readonly migrations: readonly DefinedAccessMigration[];
  readonly relationshipTable?: string;
  readonly migrationsTable?: string;
  readonly now?: () => number;
};

/**
 * Run pending `(from, to)` access migrations against SQLite.
 * Creates `dads_access_migrations` if missing, runs each pending migration in
 * a `BEGIN` / `COMMIT` / `ROLLBACK` transaction, executes `copyRole` and
 * `dropRole` ops idempotently, and skips already-applied IDs on rerun.
 */
export async function runSqliteAccessMigrations(
  options: RunSqliteAccessMigrationsOptions,
): Promise<AccessMigrationRunResult> {
  const namespace = assertNamespace(options.namespace);
  const relationshipTable = assertSqlIdentifier(
    options.relationshipTable ?? DEFAULT_RELATIONSHIP_TABLE,
    "relationshipTable",
  );
  const migrationsTable = assertSqlIdentifier(
    options.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE,
    "migrationsTable",
  );
  assertUniqueMigrationIds(options.migrations.map((m) => m.id));

  const executor = toSqliteMigrationExecutor(options.executor);
  const now = options.now ?? (() => Date.now());

  await ensureSqliteMigrationsTable(executor, migrationsTable);
  const alreadyApplied = await readSqliteAppliedIds(
    executor,
    migrationsTable,
    namespace,
  );

  return executePendingSqliteMigrations({
    executor,
    namespace,
    migrations: options.migrations,
    alreadyApplied,
    relationshipTable,
    migrationsTable,
    now,
  });
}

async function executePendingSqliteMigrations(input: {
  readonly executor: SqliteMigrationExecutor;
  readonly namespace: string;
  readonly migrations: readonly DefinedAccessMigration[];
  readonly alreadyApplied: ReadonlySet<string>;
  readonly relationshipTable: string;
  readonly migrationsTable: string;
  readonly now: () => number;
}): Promise<AccessMigrationRunResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of input.migrations) {
    if (input.alreadyApplied.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    await runInSqliteTransaction(input.executor, async () => {
      for (const op of migration.ops) {
        await executeSqliteStepOp(
          input.executor,
          input.relationshipTable,
          input.namespace,
          op,
        );
      }
      await recordSqliteMigration(
        input.executor,
        input.migrationsTable,
        input.namespace,
        migration.id,
        input.now(),
      );
    });
    applied.push(migration.id);
  }

  return { applied, skipped };
}

async function ensureSqliteMigrationsTable(
  executor: SqliteMigrationExecutor,
  migrationsTable: string,
): Promise<void> {
  await executor.exec(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, id)
    )
  `);
}

async function readSqliteAppliedIds(
  executor: SqliteMigrationExecutor,
  migrationsTable: string,
  namespace: string,
): Promise<ReadonlySet<string>> {
  const rows = await executor.all(
    `SELECT id FROM ${migrationsTable} WHERE namespace = ? ORDER BY id`,
    [namespace],
  );
  return new Set(rows.map((row) => readStringField(row, "id")));
}

async function runInSqliteTransaction(
  executor: SqliteMigrationExecutor,
  work: () => Promise<void>,
): Promise<void> {
  await executor.exec("BEGIN");
  try {
    await work();
    await executor.exec("COMMIT");
  } catch (error) {
    await rollbackSqliteQuietly(executor);
    throw error;
  }
}

async function rollbackSqliteQuietly(
  executor: SqliteMigrationExecutor,
): Promise<void> {
  try {
    await executor.exec("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}

async function executeSqliteStepOp(
  executor: SqliteMigrationExecutor,
  relationshipTable: string,
  namespace: string,
  op: AccessMigrationStepOp,
): Promise<void> {
  if (op.kind === "copy-role") {
    await executor.run(
      `INSERT INTO ${relationshipTable} (
        namespace, resource_kind, resource_id, relation,
        subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at
      )
      SELECT
        namespace, ?, resource_id, ?,
        subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at
      FROM ${relationshipTable}
      WHERE namespace = ? AND resource_kind = ? AND relation = ?
      ON CONFLICT (
        namespace, resource_kind, resource_id, relation,
        subject_kind, subject_id, subject_relation, subject_is_wildcard
      ) DO UPDATE SET expires_at = excluded.expires_at`,
      [op.to.resource, op.to.role, namespace, op.from.resource, op.from.role],
    );
    return;
  }
  await executor.run(
    `DELETE FROM ${relationshipTable}
     WHERE namespace = ? AND resource_kind = ? AND relation = ?`,
    [namespace, op.target.resource, op.target.role],
  );
}

async function recordSqliteMigration(
  executor: SqliteMigrationExecutor,
  migrationsTable: string,
  namespace: string,
  id: string,
  appliedAtMs: number,
): Promise<void> {
  await executor.run(
    `INSERT OR IGNORE INTO ${migrationsTable} (namespace, id, applied_at)
     VALUES (?, ?, ?)`,
    [namespace, id, appliedAtMs],
  );
}
