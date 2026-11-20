import type {
  PostgresQueryResult as QueryResult,
  PostgresQueryResultRow as QueryResultRow,
} from "@dads-framework/postgres";

/**
 * The runner's journal tables, and the read-only view of them. Kept apart
 * from the runner so a reader (the API's status page) can see what a
 * database ran without bundling node-pg-migrate.
 */
export const NODE_PG_JOURNAL_SCHEMA = "dads_migration";
export const NODE_PG_APPLIED_TABLE = "dads_node_pg_migrations";
export const NODE_PG_CHECKSUM_TABLE = "dads_node_pg_checksums";
export const NODE_PG_CHECKSUM_STAGING_TABLE = "dads_node_pg_checksum_staging";
/** An older runner sees this unknown applied identity and refuses before SQL. */
export const NODE_PG_GRAPH_PROTOCOL = "__dads_dependency_migration_graph_v1__";

/** What reading the journal needs: a `pg` Client or Pool both fit. */
export type NodePgJournalQueryClient = {
  query<Row extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};

/** One applied-journal row joined with its checksum row, if it has one. */
export type AppliedNodePgMigration = {
  /** The journal name: the file name without `.ts`. */
  journalName: string;
  ranAt: Date;
  /** Null when the checksum journal has no row for it (or does not exist). */
  sha256: string | null;
};

/**
 * Reads what this database recorded as applied, in the order it ran — read
 * only, for reporting. A database the runner never touched has no journal
 * tables, which reads as nothing applied rather than an error.
 *
 * `run_on` is a `timestamp` without zone that node-pg-migrate fills with
 * NOW() in the writing session's zone; it is read back in this session's zone
 * (the same server default) so the Date is the instant it ran, not a
 * wall-clock reading reinterpreted in the API process's zone.
 */
export async function readAppliedNodePgJournal(
  client: NodePgJournalQueryClient,
): Promise<AppliedNodePgMigration[]> {
  if (
    !(await relationExists(
      client,
      NODE_PG_JOURNAL_SCHEMA,
      NODE_PG_APPLIED_TABLE,
    ))
  ) {
    return [];
  }
  const hasChecksums = await relationExists(
    client,
    NODE_PG_JOURNAL_SCHEMA,
    NODE_PG_CHECKSUM_TABLE,
  );
  const result = await client.query<{
    name: string;
    ran_at: Date;
    sha256: string | null;
  }>(
    hasChecksums
      ? `SELECT applied.name,
                applied.run_on AT TIME ZONE current_setting('TimeZone') AS ran_at,
                checksum.sha256
         FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}" applied
         LEFT JOIN "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_TABLE}" checksum
           ON checksum.name = applied.name
         WHERE applied.name <> $1
         ORDER BY applied.run_on, applied.id`
      : `SELECT name,
                run_on AT TIME ZONE current_setting('TimeZone') AS ran_at,
                NULL::varchar AS sha256
         FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}"
         WHERE name <> $1
         ORDER BY run_on, id`,
    [NODE_PG_GRAPH_PROTOCOL],
  );
  return result.rows.map((row) => ({
    journalName: row.name,
    ranAt: row.ran_at,
    sha256: row.sha256,
  }));
}

/** True when `schema.table` exists as an ordinary table. */
export async function relationExists(
  client: NodePgJournalQueryClient,
  schemaName: string,
  tableName: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
     ) AS exists`,
    [schemaName, tableName],
  );
  return result.rows[0]?.exists === true;
}
