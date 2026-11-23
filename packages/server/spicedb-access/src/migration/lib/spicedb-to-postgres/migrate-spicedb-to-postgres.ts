import {
  emitTypeScriptFromZed,
  parseZed,
  type AccessIrDefinition,
} from "@dads-framework/access";

import {
  assertNamespace,
  assertPositiveInt,
  assertSqlIdentifier,
  DEFAULT_RELATIONSHIP_TABLE,
  type PgMigrationClient,
  type PgMigrationExecutor,
} from "../access-migrations/sql-migration-types.js";
import {
  createAuthzedMigrationSource,
  isAuthzedV1ClientLike,
  type AuthzedV1ClientLike,
  type SpiceDbExportedTuple,
  type SpiceDbMigrationSource,
} from "./authzed-client-adapter.js";
import { ensurePostgresRelationshipSchema } from "./postgres-relationship-ddl.js";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_PAGE_SIZE = 1000;

export type MigrateSpiceDbToPostgresOptions = {
  /** Either a `SpiceDbMigrationSource` or a raw `@authzed/authzed-node` v1 client. */
  readonly spiceDb: SpiceDbMigrationSource | AuthzedV1ClientLike;
  readonly postgres: PgMigrationExecutor;
  readonly namespace: string;
  readonly batchSize?: number;
  readonly exportPageSize?: number;
  readonly relationshipTable?: string;
  /** Optional override SQL statements (e.g. `relationshipSchemaMigration.sql`). */
  readonly schemaSql?: readonly string[];
  readonly skipSchemaSetup?: boolean;
  /** Optional observer invoked after each batch is flushed to Postgres. */
  readonly onBatch?: (batch: readonly SpiceDbExportedTuple[]) => void;
};

export type MigrateSpiceDbToPostgresResult = {
  readonly schemaZed: string;
  readonly generatedTypeScript: string;
  readonly definitions: readonly AccessIrDefinition[];
  readonly exportedCount: number;
  readonly writtenCount: number;
  readonly zedToken: string | undefined;
};

/**
 * Migrate a live SpiceDB instance into Postgres:
 * 1. Read live `.zed` schema, parse via `parseZed` (fail-fast on unsupported
 *    caveats before touching Postgres), and emit Dads TypeScript.
 * 2. Ensure the Postgres relationship table and `expires_at` column exist.
 * 3. Stream live relationships via `ExportBulkRelationships` and upsert into
 *    Postgres in idempotent batches, preserving `subject_relation`, wildcards,
 *    and `optional_expires_at` -> `expires_at`.
 */
export async function migrateSpiceDbToPostgres(
  options: MigrateSpiceDbToPostgresOptions,
): Promise<MigrateSpiceDbToPostgresResult> {
  const namespace = assertNamespace(options.namespace);
  const relationshipTable = assertSqlIdentifier(
    options.relationshipTable ?? DEFAULT_RELATIONSHIP_TABLE,
    "relationshipTable",
  );
  const batchSize = assertPositiveInt(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    "batchSize",
  );
  const exportPageSize = assertPositiveInt(
    options.exportPageSize ?? DEFAULT_PAGE_SIZE,
    "exportPageSize",
  );

  const source = isAuthzedV1ClientLike(options.spiceDb)
    ? createAuthzedMigrationSource(options.spiceDb)
    : options.spiceDb;

  const { schemaText, zedToken } = await source.readSchema();
  if (schemaText.trim() === "") {
    throw new Error("SpiceDB returned an empty schema");
  }

  // Step 1: Parse and generate TypeScript BEFORE touching Postgres so
  // unsupported caveats or syntax errors fail fast with line numbers.
  const definitions = parseZed(schemaText);
  const generatedTypeScript = emitTypeScriptFromZed(schemaText);

  // Step 2: Ensure Postgres relationship schema and expiration column exist.
  if (options.skipSchemaSetup !== true) {
    await ensurePostgresRelationshipSchema(
      options.postgres,
      relationshipTable,
      options.schemaSql,
    );
  }

  // Step 3: Stream tuples from SpiceDB and upsert in idempotent batches.
  const counts = await streamAndUpsertTuples({
    source,
    postgres: options.postgres,
    namespace,
    relationshipTable,
    batchSize,
    exportPageSize,
    zedToken,
    onBatch: options.onBatch,
  });

  return {
    schemaZed: schemaText,
    generatedTypeScript,
    definitions,
    exportedCount: counts.exportedCount,
    writtenCount: counts.writtenCount,
    zedToken,
  };
}

type StreamUpsertInput = {
  readonly source: SpiceDbMigrationSource;
  readonly postgres: PgMigrationClient;
  readonly namespace: string;
  readonly relationshipTable: string;
  readonly batchSize: number;
  readonly exportPageSize: number;
  readonly zedToken: string | undefined;
  readonly onBatch:
    ((batch: readonly SpiceDbExportedTuple[]) => void) | undefined;
};

async function streamAndUpsertTuples(
  input: StreamUpsertInput,
): Promise<{ readonly exportedCount: number; readonly writtenCount: number }> {
  let exportedCount = 0;
  let writtenCount = 0;
  let buffer: SpiceDbExportedTuple[] = [];

  const stream = input.source.exportRelationships({
    pageSize: input.exportPageSize,
    ...(input.zedToken === undefined ? {} : { zedToken: input.zedToken }),
  });

  for await (const page of stream) {
    for (const tuple of page) {
      exportedCount += 1;
      buffer.push(tuple);
      if (buffer.length >= input.batchSize) {
        writtenCount += await flushTupleBatch(input, buffer);
        buffer = [];
      }
    }
  }

  if (buffer.length > 0) {
    writtenCount += await flushTupleBatch(input, buffer);
  }

  return { exportedCount, writtenCount };
}

async function flushTupleBatch(
  input: StreamUpsertInput,
  batch: readonly SpiceDbExportedTuple[],
): Promise<number> {
  const rows = deduplicateTuples(batch);
  await upsertPostgresTupleBatch(
    input.postgres,
    input.relationshipTable,
    input.namespace,
    rows,
  );
  input.onBatch?.(rows);
  return rows.length;
}

async function upsertPostgresTupleBatch(
  client: PgMigrationClient,
  table: string,
  namespace: string,
  rows: readonly SpiceDbExportedTuple[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO ${table} (
      namespace, resource_kind, resource_id, relation,
      subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at
    )
    SELECT $1, kind, resource, relation, subject, subject_id, subject_relation, wildcard, expires_at
    FROM unnest(
      $2::text[], $3::text[], $4::text[], $5::text[],
      $6::text[], $7::text[], $8::boolean[], $9::timestamptz[]
    ) AS input(kind, resource, relation, subject, subject_id, subject_relation, wildcard, expires_at)
    ON CONFLICT (
      namespace, resource_kind, resource_id, relation,
      subject_kind, subject_id, subject_relation, subject_is_wildcard
    ) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [
      namespace,
      rows.map(({ resource }) => resource.type),
      rows.map(({ resource }) => resource.id),
      rows.map(({ relation }) => relation),
      rows.map(({ subject }) => subject.type),
      rows.map(({ subject }) => (subject.id === "*" ? "" : subject.id)),
      rows.map(({ subject }) => subject.relation ?? ""),
      rows.map(({ subject }) => subject.id === "*"),
      rows.map(({ expiresAt }) => expiresAt ?? null),
    ],
  );
}

function deduplicateTuples(
  tuples: readonly SpiceDbExportedTuple[],
): readonly SpiceDbExportedTuple[] {
  const byKey = new Map<string, SpiceDbExportedTuple>();
  for (const tuple of tuples) {
    const isWildcard = tuple.subject.id === "*";
    const key = [
      tuple.resource.type,
      tuple.resource.id,
      tuple.relation,
      tuple.subject.type,
      isWildcard ? "" : tuple.subject.id,
      tuple.subject.relation ?? "",
      isWildcard ? "1" : "0",
    ].join("\u0000");
    byKey.set(key, tuple);
  }
  return [...byKey.values()];
}
