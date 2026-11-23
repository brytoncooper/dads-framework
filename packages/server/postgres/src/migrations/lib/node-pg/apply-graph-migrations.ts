import { MigrationBuilder } from "node-pg-migrate";
import type {
  PostgresClient as Client,
  PostgresQueryConfig as QueryConfig,
} from "../../../index.js";
import { applyConcurrentIndexMigration } from "./apply-concurrent-index-migration.js";
import type { DiscoveredDomainMigration } from "./domain-migration.js";
import { NodePgMigrationJournalError } from "./migration-journal-error.js";
import {
  NODE_PG_APPLIED_TABLE,
  NODE_PG_GRAPH_PROTOCOL,
  NODE_PG_JOURNAL_SCHEMA,
} from "./node-pg-journal.js";

/**
 * The protocol fence, DDL, applied rows and trigger-written checksums commit
 * together. A file exporting `ownTransaction = true` commits alone: earlier
 * files commit before it, and a failure rolls back only the batch it is in.
 * A file exporting `buildsIndexesConcurrently = true` also runs alone, but
 * outside any transaction — the one exception, limited to concurrent index
 * statements (see `applyConcurrentIndexMigration`).
 */
export async function applyGraphMigrations(
  client: Client,
  pending: readonly DiscoveredDomainMigration[],
  protocolApplied: boolean,
): Promise<void> {
  let recordProtocol = !protocolApplied;
  for (const batch of splitIntoTransactions(pending)) {
    const [only] = batch;
    if (batch.length === 1 && only?.buildsIndexesConcurrently === true) {
      const writeProtocol = recordProtocol;
      await applyConcurrentIndexMigration(client, only, async (journal) => {
        if (writeProtocol) await recordApplied(journal, NODE_PG_GRAPH_PROTOCOL);
        await recordApplied(journal, only.journalName);
      });
    } else {
      await applyBatch(client, batch, recordProtocol);
    }
    recordProtocol = false;
  }
}

function splitIntoTransactions(
  pending: readonly DiscoveredDomainMigration[],
): readonly (readonly DiscoveredDomainMigration[])[] {
  const batches: DiscoveredDomainMigration[][] = [];
  let shared: DiscoveredDomainMigration[] | undefined;
  for (const migration of pending) {
    if (
      migration.ownTransaction === true ||
      migration.buildsIndexesConcurrently === true
    ) {
      batches.push([migration]);
      shared = undefined;
    } else if (shared === undefined) {
      shared = [migration];
      batches.push(shared);
    } else {
      shared.push(migration);
    }
  }
  return batches;
}

async function applyBatch(
  client: Client,
  batch: readonly DiscoveredDomainMigration[],
  recordProtocol: boolean,
): Promise<void> {
  await client.query("BEGIN");
  try {
    if (recordProtocol) await recordApplied(client, NODE_PG_GRAPH_PROTOCOL);
    const database = {
      query: client.query.bind(client),
      select: async (
        query: string | QueryConfig,
        values?: unknown[],
      ): Promise<unknown[]> =>
        (await client.query<Record<string, unknown>>(query, values)).rows,
    };
    for (const migration of batch) {
      const builder = new MigrationBuilder(database, undefined, false, {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      });
      await migration.up(builder);
      if (!builder.isUsingTransaction()) {
        throw new NodePgMigrationJournalError(
          "NODE_PG_MIGRATION_TRANSACTION_REQUIRED",
          migration.journalName,
          "dependency migrations must keep SQL and journal changes in one transaction",
        );
      }
      for (const statement of builder.getSqlSteps()) {
        await client.query(statement);
      }
      await recordApplied(client, migration.journalName);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function recordApplied(client: Client, name: string): Promise<void> {
  await client.query(
    `INSERT INTO "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}" (name, run_on) VALUES ($1, NOW())`,
    [name],
  );
}
