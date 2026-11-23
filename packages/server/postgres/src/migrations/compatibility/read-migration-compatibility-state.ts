import { createHash } from "node:crypto";
import type { PostgresClient as Client } from "../../index.js";

import { CATALOG_STATE, USER_SCHEMAS } from "./compatibility-catalog-queries.js";

const READ_FORMAT = {
  search_path: "pg_catalog",
  TimeZone: "UTC",
  DateStyle: "ISO, YMD",
  IntervalStyle: "iso_8601",
  extra_float_digits: "3",
  bytea_output: "hex",
  row_security: "off",
};

export class UnsupportedMigrationCompatibilityReplicationStateError extends Error {
  readonly code = "MIGRATION_COMPATIBILITY_UNSUPPORTED_REPLICATION_STATE";

  constructor(readonly reason: "subscriptions" | "publication-catalog-version") {
    super(
      reason === "subscriptions"
        ? "Database subscriptions require a dedicated-cluster migration rehearsal; external replication and slot state cannot be compared safely in cloned databases."
        : "Publication-aware migration comparison requires PostgreSQL 15 or newer.",
    );
    this.name = "UnsupportedMigrationCompatibilityReplicationStateError";
  }
}

/**
 * Compares quiescent private fixture databases using the catalog objects above
 * and every retained value. This is evidence, not a proof arbitrary SQL commutes.
 * Physical OIDs and table-column positions are absent; generated internal FK
 * trigger names are represented by their constraint and trigger behavior.
 */
export async function readMigrationCompatibilityState(client: Client): Promise<MigrationCompatibilityState> {
  let failure: unknown;
  try {
    await refuseUnsupportedReplicationState(client);
    return await withReadFormat(client, () => readCanonicalState(client));
  } catch (error) {
    if (error instanceof UnsupportedMigrationCompatibilityReplicationStateError) throw error;
    failure = error;
  }
  // Driver errors can contain input values; compatibility evidence never does,
  // so only the SQLSTATE leaves this function, never the driver error itself.
  throw new Error(`Migration compatibility state could not be read deterministically${sqlStateSuffix(failure)}`);
}

type MigrationCompatibilityState = {
  schema: string;
  data: Readonly<Record<string, { rows: number; sha256: string }>>;
};

async function refuseUnsupportedReplicationState(client: Client): Promise<void> {
  const replication = await client.query<{
    supports_publication_membership: boolean;
    has_subscriptions: boolean;
  }>(`
    SELECT pg_catalog.to_regclass('pg_catalog.pg_publication_namespace') IS NOT NULL AS supports_publication_membership,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_subscription
        WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
      ) AS has_subscriptions
  `);
  for (const state of replication.rows) {
    if (!state.supports_publication_membership) {
      throw new UnsupportedMigrationCompatibilityReplicationStateError("publication-catalog-version");
    }
    if (state.has_subscriptions) {
      throw new UnsupportedMigrationCompatibilityReplicationStateError("subscriptions");
    }
  }
}

/** Runs `read` under READ_FORMAT's settings, restoring the previous ones after. */
async function withReadFormat<T>(client: Client, read: () => Promise<T>): Promise<T> {
  const previous = await client.query<{ name: string; value: string }>(
    "SELECT name, current_setting(name) AS value FROM unnest($1::text[]) settings(name)",
    [Object.keys(READ_FORMAT)],
  );
  try {
    for (const [name, value] of Object.entries(READ_FORMAT)) {
      await client.query("SELECT pg_catalog.set_config($1, $2, false)", [name, value]);
    }
    return await read();
  } finally {
    for (const { name, value } of previous.rows) {
      await client.query("SELECT pg_catalog.set_config($1, $2, false)", [name, value]);
    }
  }
}

async function readCanonicalState(client: Client): Promise<MigrationCompatibilityState> {
  const schema = hashRows(await readCanonicalRows(client, CATALOG_STATE)).sha256;
  const relations = await client.query<{
    schema_name: string;
    relation_name: string;
    relation_kind: string;
  }>(`
    SELECT n.nspname AS schema_name, c.relname AS relation_name, c.relkind AS relation_kind
    FROM pg_catalog.pg_class c JOIN (${USER_SCHEMAS}) n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'm', 'f', 'S')
      AND NOT (n.nspname = 'public' AND c.relname = 'audit_log')
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
  `);
  const data: Record<string, { rows: number; sha256: string }> = {};
  for (const relation of relations.rows) {
    const name = `${quoteIdentifier(relation.schema_name)}.${quoteIdentifier(relation.relation_name)}`;
    const query =
      relation.relation_kind === "S"
        ? `SELECT jsonb_build_object('last_value', last_value::text, 'is_called', is_called)::text AS canonical FROM ${name}`
        : `SELECT to_jsonb(retained_row)::text AS canonical FROM ${name} retained_row ORDER BY to_jsonb(retained_row)::text COLLATE "C"`;
    data[name] = hashRows(await readCanonicalRows(client, query));
  }
  return { schema, data };
}

function sqlStateSuffix(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code)
    ? ` (PostgreSQL ${error.code})`
    : "";
}

async function readCanonicalRows(client: Client, query: string): Promise<readonly string[]> {
  const result = await client.query<{ canonical: string }>(query);
  return result.rows.map(({ canonical }) => canonical);
}

function hashRows(rows: readonly string[]): { rows: number; sha256: string } {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash
      .update(String(Buffer.byteLength(row)))
      .update(":")
      .update(row)
      .update("\n");
  }
  return { rows: rows.length, sha256: hash.digest("hex") };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
