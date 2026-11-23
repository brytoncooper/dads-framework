import type { MigrationWorkspace } from "./migration-workspace.js";
import { PG_MIGRATE_LOCK_ID, runner } from "node-pg-migrate";
import { connectPostgresClient, stampClientWithActor, type PostgresClient as Client } from "../../../index.js";

import { systemActor } from "@dads-framework/core/audit-actor";

import { applyGraphMigrations } from "./apply-graph-migrations.js";
import { discoverDomainMigrations } from "./discover-domain-migrations.js";
import type { DiscoveredDomainMigration } from "./domain-migration.js";
import { fileSha256 } from "./migration-checksum.js";
import { NodePgMigrationJournalError } from "./migration-journal-error.js";
import {
  NODE_PG_APPLIED_TABLE,
  NODE_PG_CHECKSUM_STAGING_TABLE,
  NODE_PG_CHECKSUM_TABLE,
  NODE_PG_GRAPH_PROTOCOL,
  NODE_PG_JOURNAL_SCHEMA,
  relationExists,
} from "./node-pg-journal.js";
import { legacyFingerprint, readValidatedMigrationPlan } from "./read-validated-migration-plan.js";

export {
  NODE_PG_APPLIED_TABLE,
  NODE_PG_CHECKSUM_STAGING_TABLE,
  NODE_PG_CHECKSUM_TABLE,
  NODE_PG_JOURNAL_SCHEMA,
} from "./node-pg-journal.js";

export type NodePgMigrationRunnerInput = {
  databaseUrl: string;
  workspace: MigrationWorkspace;
};

export { NodePgMigrationJournalError } from "./migration-journal-error.js";

export async function stampNodePgJournalAsApplied(input: NodePgMigrationRunnerInput): Promise<void> {
  const discovered = await discoverDomainMigrations({
    workspace: input.workspace,
  });
  if (discovered.some((migration) => migration.dependsOn !== undefined)) {
    throw new NodePgMigrationJournalError(
      "NODE_PG_MIGRATION_GRAPH_ADOPTION_REFUSED",
      "",
      "schema equality cannot prove dependency migration data changes; migrate from a recorded journal",
    );
  }
  const client = await connectPostgresClient(input.databaseUrl);
  try {
    await lockMigrations(client);
    await stampMigrationActor(client);
    await ensureChecksumJournal(client);
    await ensureAppliedJournal(client);
    await client.query("BEGIN");
    for (const migration of discovered) {
      await client.query(
        `INSERT INTO "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_TABLE}" (name, sha256, applied_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (name) DO NOTHING`,
        [migration.journalName, await fileSha256(migration.filePath)],
      );
      await client.query(
        `INSERT INTO "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}" (name, run_on)
         SELECT $1::varchar, NOW()
         WHERE NOT EXISTS (
           SELECT 1
           FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}"
           WHERE name = $1::varchar
         )`,
        [migration.journalName],
      );
    }
    await client.query("COMMIT");
    await installChecksumTrigger(client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

export async function runNodePgMigrations(input: NodePgMigrationRunnerInput): Promise<void> {
  const discovered = await discoverDomainMigrations({
    workspace: input.workspace,
  });
  const client = await connectPostgresClient(input.databaseUrl);
  try {
    await lockMigrations(client);
    await stampMigrationActor(client);
    const { pending, protocolApplied } = await readValidatedMigrationPlan(client, discovered);
    if (pending.length === 0) {
      return;
    }

    await ensureChecksumJournal(client);
    await stagePendingChecksums(client, pending);
    const legacy = discovered.filter((migration) => migration.dependsOn === undefined);
    if (pending.some((migration) => migration.dependsOn === undefined))
      await runner({
        dbClient: client,
        dir: legacy.map((migration) => migration.filePath),
        useGlob: true,
        direction: "up",
        migrationsTable: NODE_PG_APPLIED_TABLE,
        migrationsSchema: NODE_PG_JOURNAL_SCHEMA,
        createMigrationsSchema: true,
        checkOrder: true,
        singleTransaction: true,
        noLock: true,
        logger: silentLogger,
      });
    const graph = pending.filter((migration) => migration.dependsOn !== undefined);
    if (graph.length > 0) {
      await client.query(
        `INSERT INTO "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_STAGING_TABLE}" (name, sha256) VALUES ($1, $2)`,
        [NODE_PG_GRAPH_PROTOCOL, await legacyFingerprint(discovered)],
      );
      await applyGraphMigrations(client, graph, protocolApplied);
    }
  } finally {
    await client.end();
  }
}

/**
 * Attributes everything this connection does to `system:migration`.
 * The runner holds one raw client for the whole run rather than a
 * pool, so the stamp goes on once, right after connecting, and the session
 * keeps it — which matters for the migrations that backfill data rather than
 * only change shape.
 */
/** Every row a migration writes is audited as the system's migration actor. */
async function stampMigrationActor(client: Client): Promise<void> {
  await stampClientWithActor(client, systemActor("migration"));
}

async function lockMigrations(client: Client): Promise<void> {
  const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
    PG_MIGRATE_LOCK_ID,
  ]);
  if (result.rows[0]?.locked !== true) {
    throw new NodePgMigrationJournalError(
      "NODE_PG_MIGRATION_LOCKED",
      "",
      "another migration connection holds the migration advisory lock",
    );
  }
}

async function ensureChecksumJournal(client: Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${NODE_PG_JOURNAL_SCHEMA}"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_TABLE}" (
      name varchar(255) PRIMARY KEY,
      sha256 varchar(64) NOT NULL,
      applied_at timestamptz NOT NULL
    )`,
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_STAGING_TABLE}" (
      name varchar(255) PRIMARY KEY,
      sha256 varchar(64) NOT NULL
    )`,
  );
  await client.query(
    `CREATE OR REPLACE FUNCTION "${NODE_PG_JOURNAL_SCHEMA}".write_node_pg_checksum()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $$
     BEGIN
       INSERT INTO "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_TABLE}" (name, sha256, applied_at)
       SELECT name, sha256, NOW()
       FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_STAGING_TABLE}"
       WHERE name = NEW.name;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'missing checksum staging for %', NEW.name;
       END IF;
       RETURN NEW;
     END;
     $$`,
  );
}

async function stagePendingChecksums(client: Client, pending: readonly DiscoveredDomainMigration[]): Promise<void> {
  await client.query(`TRUNCATE "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_STAGING_TABLE}"`);
  for (const migration of pending) {
    await client.query(
      `INSERT INTO "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_STAGING_TABLE}" (name, sha256)
       VALUES ($1, $2)`,
      [migration.journalName, await fileSha256(migration.filePath)],
    );
  }

  await ensureAppliedJournal(client);
  await installChecksumTrigger(client);
}

async function ensureAppliedJournal(client: Client): Promise<void> {
  if (!(await relationExists(client, NODE_PG_JOURNAL_SCHEMA, NODE_PG_APPLIED_TABLE))) {
    await client.query(
      `CREATE TABLE "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}" (
        id SERIAL PRIMARY KEY,
        name varchar(255) NOT NULL,
        run_on timestamp NOT NULL
      )`,
    );
  }
}

async function installChecksumTrigger(client: Client): Promise<void> {
  await client.query(
    `DROP TRIGGER IF EXISTS dads_node_pg_checksums_on_apply
     ON "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}"`,
  );
  await client.query(
    `CREATE TRIGGER dads_node_pg_checksums_on_apply
     AFTER INSERT ON "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}"
     FOR EACH ROW
     EXECUTE FUNCTION "${NODE_PG_JOURNAL_SCHEMA}".write_node_pg_checksum()`,
  );
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
