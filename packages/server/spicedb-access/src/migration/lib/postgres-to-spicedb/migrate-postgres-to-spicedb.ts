import {
  emitAccessIr,
  emitZed,
  type AccessIrDefinition,
  type AccessModel,
} from "@dads-framework/access";

import {
  assertNamespace,
  assertPositiveInt,
  assertSqlIdentifier,
  DEFAULT_RELATIONSHIP_TABLE,
  type PgMigrationClient,
  type PgMigrationRow,
} from "../access-migrations/sql-migration-types.js";
import type { SpiceDbExportedTuple } from "../spicedb-to-postgres/authzed-client-adapter.js";
import {
  createAuthzedMigrationTarget,
  isAuthzedWriteClientLike,
  type AuthzedWriteClientLike,
  type SpiceDbMigrationTarget,
} from "./authzed-target-adapter.js";
import {
  columnRelationOutboxTriggerSql,
  resolveExportColumnRelations,
  type ColumnRelationOutboxTriggerDdl,
  type PostgresColumnRelationExportBinding,
  type ResolvedExportColumnRelation,
} from "./column-relation-outbox-triggers.js";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_PAGE_SIZE = 2_000;

export type MigratePostgresToSpiceDbOptions = {
  readonly model: AccessModel;
  readonly postgres: PgMigrationClient;
  /** Either a `SpiceDbMigrationTarget` or a raw `@authzed/authzed-node` v1 client. */
  readonly spiceDb: SpiceDbMigrationTarget | AuthzedWriteClientLike;
  readonly namespace: string;
  /** Optional `columnRelations` bindings to materialize into SpiceDB alongside the tuple table. */
  readonly columnRelations?: readonly PostgresColumnRelationExportBinding[];
  readonly relationshipTable?: string;
  readonly batchSize?: number;
  readonly pageSize?: number;
  /** Skip `WriteSchema` when the caller manages SpiceDB schema migrations separately. */
  readonly skipSchemaWrite?: boolean;
  /** Include already-expired rows from `dad_authorization_relationship` (defaults to `false`). */
  readonly includeExpired?: boolean;
  /** Optional observer invoked after each batch is written to SpiceDB. */
  readonly onBatch?: (batch: readonly SpiceDbExportedTuple[]) => void;
};

export type MigratePostgresToSpiceDbResult = {
  readonly schemaZed: string;
  readonly definitions: readonly AccessIrDefinition[];
  readonly tupleTableCount: number;
  readonly columnRelationCount: number;
  readonly totalWrittenCount: number;
  readonly zedToken: string | undefined;
  /** Ready-to-apply outbox sync trigger DDL for any configured `columnRelations`. */
  readonly outboxTriggers: ColumnRelationOutboxTriggerDdl;
};

/**
 * Migrate a live Postgres authorization store (including optional
 * `columnRelations` foreign keys on application tables) into SpiceDB:
 * 1. Emit the `.zed` schema from `AccessModel` and write it to SpiceDB.
 * 2. Stream active tuples from `dad_authorization_relationship` in batches and
 *    upsert (`TOUCH`) them idempotently into SpiceDB, preserving wildcards,
 *    `subject_relation`, and `expires_at`.
 * 3. Stream every non-`NULL` row from each `columnRelations` table via keyset
 *    pagination and materialize them into SpiceDB as direct tuples.
 * 4. Return idempotent `outboxTriggers` DDL so future SQL writes to
 *    column-backed tables automatically feed `authorization_outbox`.
 */
export async function migratePostgresToSpiceDb(
  options: MigratePostgresToSpiceDbOptions,
): Promise<MigratePostgresToSpiceDbResult> {
  const namespace = assertNamespace(options.namespace);
  const relationshipTable = assertSqlIdentifier(
    options.relationshipTable ?? DEFAULT_RELATIONSHIP_TABLE,
    "relationshipTable",
  );
  const batchSize = assertPositiveInt(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    "batchSize",
  );
  const pageSize = assertPositiveInt(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    "pageSize",
  );
  const resolvedColumns = resolveExportColumnRelations(
    options.model,
    options.columnRelations,
  );
  const outboxTriggers = columnRelationOutboxTriggerSql(
    options.model,
    options.columnRelations ?? [],
  );

  const target = isAuthzedWriteClientLike(options.spiceDb)
    ? createAuthzedMigrationTarget(options.spiceDb)
    : options.spiceDb;

  const definitions = emitAccessIr(options.model);
  const schemaZed = emitZed(options.model);
  if (options.skipSchemaWrite !== true) {
    await target.writeSchema(schemaZed);
  }

  const writer = createBatchWriter(target, batchSize, options.onBatch);
  const tupleTableCount = await exportTupleTable({
    postgres: options.postgres,
    table: relationshipTable,
    namespace,
    pageSize,
    includeExpired: options.includeExpired === true,
    writer,
  });

  let columnRelationCount = 0;
  for (const binding of resolvedColumns) {
    columnRelationCount += await exportColumnRelation({
      postgres: options.postgres,
      binding,
      pageSize,
      writer,
    });
  }
  await writer.flush();

  return {
    schemaZed,
    definitions,
    tupleTableCount,
    columnRelationCount,
    totalWrittenCount: writer.totalWritten(),
    zedToken: writer.lastZedToken(),
    outboxTriggers,
  };
}

type BatchWriter = {
  push(tuple: SpiceDbExportedTuple): Promise<void>;
  flush(): Promise<void>;
  totalWritten(): number;
  lastZedToken(): string | undefined;
};

function createBatchWriter(
  target: SpiceDbMigrationTarget,
  batchSize: number,
  onBatch: ((batch: readonly SpiceDbExportedTuple[]) => void) | undefined,
): BatchWriter {
  let buffer: SpiceDbExportedTuple[] = [];
  let written = 0;
  let lastToken: string | undefined;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const result = await target.writeRelationships(batch);
    if (result.zedToken !== undefined) {
      lastToken = result.zedToken;
    }
    written += batch.length;
    onBatch?.(batch);
  }

  return {
    async push(tuple: SpiceDbExportedTuple): Promise<void> {
      buffer.push(tuple);
      if (buffer.length >= batchSize) {
        await flush();
      }
    },
    flush,
    totalWritten: () => written,
    lastZedToken: () => lastToken,
  };
}

async function exportTupleTable(input: {
  readonly postgres: PgMigrationClient;
  readonly table: string;
  readonly namespace: string;
  readonly pageSize: number;
  readonly includeExpired: boolean;
  readonly writer: BatchWriter;
}): Promise<number> {
  const expiryClause = input.includeExpired
    ? ""
    : " AND (expires_at IS NULL OR expires_at > now())";
  let offset = 0;
  let count = 0;

  for (;;) {
    const result = await input.postgres.query(
      `SELECT resource_kind, resource_id, relation,
              subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at
         FROM ${input.table}
        WHERE namespace = $1${expiryClause}
        ORDER BY resource_kind, resource_id, relation,
                 subject_kind, subject_id, subject_relation, subject_is_wildcard
        LIMIT $2 OFFSET $3`,
      [input.namespace, input.pageSize, offset],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      await input.writer.push(rowToExportedTuple(row));
      count += 1;
    }
    if (result.rows.length < input.pageSize) break;
    offset += result.rows.length;
  }
  return count;
}

async function exportColumnRelation(input: {
  readonly postgres: PgMigrationClient;
  readonly binding: ResolvedExportColumnRelation;
  readonly pageSize: number;
  readonly writer: BatchWriter;
}): Promise<number> {
  const { binding } = input;
  let lastId: string | undefined;
  let count = 0;

  for (;;) {
    const query =
      lastId === undefined
        ? {
            sql: `SELECT ${binding.idColumn}::text AS resource_id, ${binding.targetIdColumn}::text AS target_id
                    FROM ${binding.table}
                   WHERE ${binding.targetIdColumn} IS NOT NULL
                   ORDER BY ${binding.idColumn}::text
                   LIMIT $1`,
            values: [input.pageSize],
          }
        : {
            sql: `SELECT ${binding.idColumn}::text AS resource_id, ${binding.targetIdColumn}::text AS target_id
                    FROM ${binding.table}
                   WHERE ${binding.targetIdColumn} IS NOT NULL
                     AND ${binding.idColumn}::text > $1
                   ORDER BY ${binding.idColumn}::text
                   LIMIT $2`,
            values: [lastId, input.pageSize],
          };
    const result = await input.postgres.query(query.sql, query.values);
    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      const resourceId = readRequiredString(row, "resource_id");
      const targetId = readRequiredString(row, "target_id");
      await input.writer.push({
        resource: { type: binding.entity, id: resourceId },
        relation: binding.relation,
        subject: { type: binding.targetEntity, id: targetId },
      });
      lastId = resourceId;
      count += 1;
    }
    if (result.rows.length < input.pageSize) break;
  }
  return count;
}

function rowToExportedTuple(row: PgMigrationRow): SpiceDbExportedTuple {
  const isWildcard = row["subject_is_wildcard"] === true;
  const subjectRelation = readOptionalString(row, "subject_relation");
  const expiresAt = readOptionalDate(row["expires_at"]);
  const subjectId = isWildcard ? "*" : readRequiredString(row, "subject_id");
  return {
    resource: {
      type: readRequiredString(row, "resource_kind"),
      id: readRequiredString(row, "resource_id"),
    },
    relation: readRequiredString(row, "relation"),
    subject: {
      type: readRequiredString(row, "subject_kind"),
      id: subjectId,
      ...(subjectRelation === undefined ? {} : { relation: subjectRelation }),
    },
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function readRequiredString(row: PgMigrationRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Expected non-empty string column "${column}" from Postgres`,
    );
  }
  return value;
}

function readOptionalString(
  row: PgMigrationRow,
  column: string,
): string | undefined {
  const value = row[column];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalDate(value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error("Invalid expires_at timestamp read from Postgres");
}
