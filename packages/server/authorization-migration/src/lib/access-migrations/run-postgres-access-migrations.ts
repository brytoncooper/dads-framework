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
  type AccessMigrationRunResult,
  type PgMigrationClient,
  type PgMigrationExecutor,
} from "./sql-migration-types.js";

export type RunPostgresAccessMigrationsOptions = {
  readonly executor: PgMigrationExecutor;
  readonly namespace: string;
  readonly migrations: readonly DefinedAccessMigration[];
  readonly relationshipTable?: string;
  readonly migrationsTable?: string;
};

/**
 * Run pending `(from, to)` access migrations against Postgres.
 * Creates `dads_access_migrations` if missing, runs each pending migration in
 * its own `BEGIN` / `COMMIT` / `ROLLBACK` transaction, executes `copyRole` and
 * `dropRole` ops idempotently, and skips already-applied IDs on rerun.
 */
export async function runPostgresAccessMigrations(
  options: RunPostgresAccessMigrationsOptions,
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

  await ensurePostgresMigrationsTable(options.executor, migrationsTable);
  const alreadyApplied = await readPostgresAppliedIds(
    options.executor,
    migrationsTable,
    namespace,
  );

  return executePendingPostgresMigrations({
    executor: options.executor,
    namespace,
    migrations: options.migrations,
    alreadyApplied,
    relationshipTable,
    migrationsTable,
  });
}

async function executePendingPostgresMigrations(input: {
  readonly executor: PgMigrationExecutor;
  readonly namespace: string;
  readonly migrations: readonly DefinedAccessMigration[];
  readonly alreadyApplied: ReadonlySet<string>;
  readonly relationshipTable: string;
  readonly migrationsTable: string;
}): Promise<AccessMigrationRunResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of input.migrations) {
    if (input.alreadyApplied.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    await runInPostgresTransaction(input.executor, async (client) => {
      for (const op of migration.ops) {
        await executePostgresStepOp(
          client,
          input.relationshipTable,
          input.namespace,
          op,
        );
      }
      await recordPostgresMigration(
        client,
        input.migrationsTable,
        input.namespace,
        migration.id,
      );
    });
    applied.push(migration.id);
  }

  return { applied, skipped };
}

async function ensurePostgresMigrationsTable(
  client: PgMigrationClient,
  migrationsTable: string,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      namespace text NOT NULL,
      id text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (namespace, id)
    )
  `);
}

async function readPostgresAppliedIds(
  client: PgMigrationClient,
  migrationsTable: string,
  namespace: string,
): Promise<ReadonlySet<string>> {
  const result = await client.query(
    `SELECT id FROM ${migrationsTable} WHERE namespace = $1 ORDER BY id`,
    [namespace],
  );
  return new Set(result.rows.map((row) => readStringField(row, "id")));
}

async function runInPostgresTransaction(
  executor: PgMigrationExecutor,
  work: (client: PgMigrationClient) => Promise<void>,
): Promise<void> {
  const pooled =
    executor.connect !== undefined ? await executor.connect() : undefined;
  const client: PgMigrationClient = pooled ?? executor;
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    pooled?.release();
  }
}

async function rollbackQuietly(client: PgMigrationClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}

async function executePostgresStepOp(
  client: PgMigrationClient,
  relationshipTable: string,
  namespace: string,
  op: AccessMigrationStepOp,
): Promise<void> {
  if (op.kind === "copy-role") {
    await client.query(
      `INSERT INTO ${relationshipTable} (
        namespace, resource_kind, resource_id, relation,
        subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at
      )
      SELECT
        namespace, $4, resource_id, $5,
        subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at
      FROM ${relationshipTable}
      WHERE namespace = $1 AND resource_kind = $2 AND relation = $3
      ON CONFLICT (
        namespace, resource_kind, resource_id, relation,
        subject_kind, subject_id, subject_relation, subject_is_wildcard
      ) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [namespace, op.from.resource, op.from.role, op.to.resource, op.to.role],
    );
    return;
  }
  await client.query(
    `DELETE FROM ${relationshipTable}
     WHERE namespace = $1 AND resource_kind = $2 AND relation = $3`,
    [namespace, op.target.resource, op.target.role],
  );
}

async function recordPostgresMigration(
  client: PgMigrationClient,
  migrationsTable: string,
  namespace: string,
  id: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ${migrationsTable} (namespace, id, applied_at)
     VALUES ($1, $2, now())
     ON CONFLICT (namespace, id) DO NOTHING`,
    [namespace, id],
  );
}
