import { createHash } from "node:crypto";
import type { PostgresClient as Client } from "../../../index.js";

import type { DiscoveredDomainMigration } from "./domain-migration.js";
import { fileSha256 } from "./migration-checksum.js";
import { NodePgMigrationJournalError } from "./migration-journal-error.js";
import {
  NODE_PG_APPLIED_TABLE,
  NODE_PG_CHECKSUM_TABLE,
  NODE_PG_GRAPH_PROTOCOL,
  NODE_PG_JOURNAL_SCHEMA,
  relationExists,
} from "./node-pg-journal.js";
import { planMigrationOrder } from "./plan-migration-order.js";

export async function readValidatedMigrationPlan(
  client: Client,
  discovered: readonly DiscoveredDomainMigration[],
): Promise<{ pending: DiscoveredDomainMigration[]; protocolApplied: boolean }> {
  const recordedApplied = await readAppliedJournal(client);
  if (
    recordedApplied.filter((row) => row.name === NODE_PG_GRAPH_PROTOCOL)
      .length > 1
  ) {
    throw new NodePgMigrationJournalError(
      "NODE_PG_MIGRATION_PROTOCOL_DUPLICATE",
      NODE_PG_GRAPH_PROTOCOL,
      "the dependency migration protocol appears more than once in the applied journal",
    );
  }
  const protocolApplied = recordedApplied.some(
    (row) => row.name === NODE_PG_GRAPH_PROTOCOL,
  );
  const applied = recordedApplied.filter(
    (row) => row.name !== NODE_PG_GRAPH_PROTOCOL,
  );
  const checksums = await readChecksumJournal(client);
  if (
    !protocolApplied &&
    applied.some((row) =>
      discovered.some(
        (migration) =>
          migration.journalName === row.name &&
          migration.dependsOn !== undefined,
      ),
    )
  ) {
    throw new NodePgMigrationJournalError(
      "NODE_PG_MIGRATION_PROTOCOL_MISSING",
      NODE_PG_GRAPH_PROTOCOL,
      "applied dependency migrations have no protocol fence",
    );
  }
  if (
    protocolApplied &&
    checksums.find((row) => row.name === NODE_PG_GRAPH_PROTOCOL)?.sha256 !==
      (await legacyFingerprint(discovered))
  ) {
    throw new NodePgMigrationJournalError(
      "NODE_PG_MIGRATION_LEGACY_HISTORY_CHANGED",
      NODE_PG_GRAPH_PROTOCOL,
      "legacy migration history differs from the sealed dependency graph baseline",
    );
  }
  await assertJournalMatchesBuild(discovered, applied, checksums);

  const ordered = planMigrationOrder(
    discovered,
    applied.map((row) => row.name),
  );
  const pending = ordered.filter(
    (migration) => !applied.some((row) => row.name === migration.journalName),
  );
  return { pending, protocolApplied };
}

export async function legacyFingerprint(
  discovered: readonly DiscoveredDomainMigration[],
): Promise<string> {
  const legacy = await Promise.all(
    discovered
      .filter((migration) => migration.dependsOn === undefined)
      .map(async (migration) => [
        migration.journalName,
        await fileSha256(migration.filePath),
      ]),
  );
  return createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
}

async function readAppliedJournal(client: Client): Promise<{ name: string }[]> {
  if (
    !(await relationExists(
      client,
      NODE_PG_JOURNAL_SCHEMA,
      NODE_PG_APPLIED_TABLE,
    ))
  ) {
    return [];
  }
  const result = await client.query<{ name: string }>(
    `SELECT name FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}" ORDER BY run_on, id`,
  );
  return result.rows;
}

async function readChecksumJournal(
  client: Client,
): Promise<{ name: string; sha256: string }[]> {
  if (
    !(await relationExists(
      client,
      NODE_PG_JOURNAL_SCHEMA,
      NODE_PG_CHECKSUM_TABLE,
    ))
  ) {
    return [];
  }
  const result = await client.query<{ name: string; sha256: string }>(
    `SELECT name, sha256 FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_TABLE}" ORDER BY name`,
  );
  return result.rows;
}

async function assertJournalMatchesBuild(
  discovered: readonly DiscoveredDomainMigration[],
  applied: readonly { name: string }[],
  checksums: readonly { name: string; sha256: string }[],
): Promise<void> {
  const discoveredByName = new Map(
    discovered.map((migration) => [migration.journalName, migration]),
  );

  for (const row of applied) {
    if (!discoveredByName.has(row.name)) {
      throw new NodePgMigrationJournalError(
        "NODE_PG_MIGRATION_DATABASE_AHEAD",
        row.name,
        `applied migration ${row.name} is missing from the current build`,
      );
    }
  }

  const checksumByName = new Map(
    checksums.map((row) => [row.name, row.sha256]),
  );
  for (const row of applied) {
    const migration = discoveredByName.get(row.name);
    if (migration === undefined) {
      continue;
    }
    const recorded = checksumByName.get(row.name);
    if (recorded === undefined) {
      throw new NodePgMigrationJournalError(
        "NODE_PG_MIGRATION_CHECKSUM_MISSING",
        row.name,
        `applied migration ${row.name} has no checksum`,
      );
    }
    const actual = await fileSha256(migration.filePath);
    if (actual !== recorded) {
      throw new NodePgMigrationJournalError(
        "NODE_PG_MIGRATION_CHECKSUM_MISMATCH",
        row.name,
        `applied migration ${row.name} does not match its checksum`,
      );
    }
  }
}
