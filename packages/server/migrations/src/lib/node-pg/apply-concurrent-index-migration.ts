import { MigrationBuilder } from "node-pg-migrate";
import type { PostgresClient as Client } from "@dads-framework/postgres";

import {
  parseConcurrentIndexStatement,
  type ConcurrentIndexStatement,
} from "../logic/parse-concurrent-index-statement.js";
import type { DiscoveredDomainMigration } from "./domain-migration.js";
import { NodePgMigrationJournalError } from "./migration-journal-error.js";

type CreateStatement = Extract<ConcurrentIndexStatement, { kind: "create" }>;

/**
 * Runs a `buildsIndexesConcurrently` file: its index statements one by one,
 * outside any transaction, so a large live table keeps taking writes while
 * the index builds. The applied row (and the protocol fence, when this is the
 * first graph work) commit afterwards in their own short transaction.
 *
 * Every statement is `IF [NOT] EXISTS`, so a run that dies between the build
 * and the journal row simply re-runs. A failed concurrent build leaves an
 * INVALID index behind; it is dropped before the error surfaces, and again
 * before the next attempt in case the process died before it could clean up.
 */
export async function applyConcurrentIndexMigration(
  client: Client,
  migration: DiscoveredDomainMigration,
  recordJournal: (client: Client) => Promise<void>,
): Promise<void> {
  const statements = await readIndexStatements(migration);
  for (const statement of statements) {
    if (statement.kind === "drop") await client.query(statement.sql);
    else await buildIndex(client, migration, statement);
  }
  await client.query("BEGIN");
  try {
    await recordJournal(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Collects the file's SQL without a live database: `pgm.db` refuses, so the
 * file cannot run anything the statement check never saw.
 */
async function readIndexStatements(
  migration: DiscoveredDomainMigration,
): Promise<ConcurrentIndexStatement[]> {
  const refuseDirectQuery = (): Promise<never> =>
    Promise.reject(
      new NodePgMigrationJournalError(
        "NODE_PG_MIGRATION_CONCURRENT_INDEX_STATEMENT_REFUSED",
        migration.journalName,
        "a buildsIndexesConcurrently migration cannot query the database directly",
      ),
    );
  const builder = new MigrationBuilder(
    { query: refuseDirectQuery, select: refuseDirectQuery },
    undefined,
    false,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );
  await migration.up(builder);

  const steps = builder.getSqlSteps();
  if (steps.length === 0)
    throw new NodePgMigrationJournalError(
      "NODE_PG_MIGRATION_CONCURRENT_INDEX_STATEMENT_REFUSED",
      migration.journalName,
      "a buildsIndexesConcurrently migration must contain at least one index statement",
    );
  return steps.map((step) => {
    const parsed = parseConcurrentIndexStatement(step);
    if (!parsed.ok)
      throw new NodePgMigrationJournalError(
        "NODE_PG_MIGRATION_CONCURRENT_INDEX_STATEMENT_REFUSED",
        migration.journalName,
        `refused statement in a buildsIndexesConcurrently migration: ${parsed.reason}`,
      );
    return parsed.statement;
  });
}

async function buildIndex(
  client: Client,
  migration: DiscoveredDomainMigration,
  statement: CreateStatement,
): Promise<void> {
  await dropInvalidIndex(client, statement);
  try {
    await client.query(statement.sql);
  } catch (error) {
    await dropInvalidIndex(client, statement).catch(() => undefined);
    throw error;
  }
  if (!(await validIndexExists(client, statement))) {
    await dropInvalidIndex(client, statement);
    throw new NodePgMigrationJournalError(
      "NODE_PG_MIGRATION_CONCURRENT_INDEX_INVALID",
      migration.journalName,
      `index ${statement.indexName} is not a valid index on ${statement.tableReference} after its build; another relation may already use the name`,
    );
  }
}

async function dropInvalidIndex(
  client: Client,
  statement: CreateStatement,
): Promise<void> {
  const invalid = await client.query<{ qualified_name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.indrelid = to_regclass($1) AND c.relname = $2 AND NOT i.indisvalid`,
    [statement.tableReference, statement.indexName],
  );
  for (const row of invalid.rows) {
    await client.query(
      `DROP INDEX CONCURRENTLY IF EXISTS ${row.qualified_name}`,
    );
  }
}

async function validIndexExists(
  client: Client,
  statement: CreateStatement,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = to_regclass($1) AND c.relname = $2 AND i.indisvalid
     ) AS exists`,
    [statement.tableReference, statement.indexName],
  );
  return result.rows[0]?.exists === true;
}
