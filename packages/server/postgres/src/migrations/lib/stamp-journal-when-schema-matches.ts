import type { MigrationWorkspace } from "./node-pg/migration-workspace.js";
import { randomBytes } from "node:crypto";
import {
  connectPostgresClient,
  type PostgresClient as Client,
} from "../../index.js";
import { journalStampDecision } from "./logic/journal-stamp-decision.js";
import { siblingDatabaseUrl } from "./logic/sibling-database-url.js";
import {
  NODE_PG_APPLIED_TABLE,
  NODE_PG_JOURNAL_SCHEMA,
  runNodePgMigrations,
  stampNodePgJournalAsApplied,
} from "./node-pg/run-node-pg-migrations.js";
import {
  publicSchemaFingerprint,
  publicTableCount,
} from "./public-schema-fingerprint.js";

export class EquivalentSchemaMismatchError extends Error {
  readonly code = "NODE_PG_SCHEMA_NOT_EQUIVALENT";

  constructor() {
    super(
      "public schema does not match the checked-in journal; refusing to drop or stamp",
    );
    this.name = "EquivalentSchemaMismatchError";
  }
}

/** One-shot leftover-schema shim. No-ops once a node-pg journal exists. */
export async function stampJournalWhenSchemaMatches(
  databaseUrl: string,
  workspace: MigrationWorkspace,
): Promise<"skipped" | "stamped"> {
  const live = await connectPostgresClient(databaseUrl);
  try {
    const decision = journalStampDecision({
      appliedCount: await appliedJournalCount(live),
      publicTableCount: await publicTableCount(live),
    });
    if (decision === "skip") {
      return "skipped";
    }

    const expected = await expectedJournalFingerprint(databaseUrl, workspace);
    const actual = await publicSchemaFingerprint(live);
    if (actual !== expected) {
      throw new EquivalentSchemaMismatchError();
    }

    await stampNodePgJournalAsApplied({ databaseUrl, workspace });
    await live.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    return "stamped";
  } finally {
    await live.end();
  }
}

async function expectedJournalFingerprint(
  databaseUrl: string,
  workspace: MigrationWorkspace,
): Promise<string> {
  const shadowName = `dads_adopt_${randomBytes(8).toString("hex")}`;
  await createSiblingDatabase(databaseUrl, shadowName);
  const shadowUrl = siblingDatabaseUrl(databaseUrl, shadowName);
  try {
    await runNodePgMigrations({
      databaseUrl: shadowUrl,
      workspace,
    });
    const shadow = await connectPostgresClient(shadowUrl);
    try {
      return await publicSchemaFingerprint(shadow);
    } finally {
      await shadow.end();
    }
  } finally {
    await dropSiblingDatabase(databaseUrl, shadowName);
  }
}

async function createSiblingDatabase(
  databaseUrl: string,
  databaseName: string,
): Promise<void> {
  const client = await connectPostgresClient(databaseUrl);
  try {
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function dropSiblingDatabase(
  databaseUrl: string,
  databaseName: string,
): Promise<void> {
  const client = await connectPostgresClient(databaseUrl);
  try {
    await client.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await client.end();
  }
}

async function appliedJournalCount(client: Client): Promise<number> {
  const existing = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`${NODE_PG_JOURNAL_SCHEMA}.${NODE_PG_APPLIED_TABLE}`],
  );
  if (existing.rows[0]?.exists !== true) {
    return 0;
  }
  const appliedCount = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}"`,
  );
  return Number(appliedCount.rows[0]?.count ?? 0);
}
