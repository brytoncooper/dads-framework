import type { ClientBase, Pool } from "pg";

/**
 * Ledger, in the shared server's `postgres` database, of the tables each
 * dropped private database touched. With `TEST_POSTGRES_STORAGE=ram` a file's
 * database is dropped when it stops, so the schema-keyed teardown
 * (verify-schema-keyed-suite.ts) reads these rows in place of the database.
 * One row per touched table, plus one row with null names per database so a
 * database that touched nothing is still counted.
 */
const RETIRED_DATABASE_TOUCHES = "dads_test_retired_database_touches";

const DUPLICATE_OBJECT_CODES = new Set(["42P07", "23505"]);

export type RetiredTouch = {
  readonly databaseName: string;
  readonly schemaName: string | null;
  readonly tableName: string | null;
};

/**
 * Read `name`'s table activity through `database` — a connection to it the
 * caller owns and closes — and write it to the ledger before a drop.
 */
export async function recordRetiredDatabaseTouches(admin: Pool, database: ClientBase, name: string): Promise<void> {
  const touched = (
    await database.query<{ schemaname: string; relname: string }>(`
      SELECT schemaname, relname
      FROM pg_stat_user_tables
      WHERE coalesce(seq_scan, 0) + coalesce(idx_scan, 0) + n_tup_ins
            + n_tup_upd + n_tup_del > 0
    `)
  ).rows;

  await ensureLedger(admin);
  await admin.query(
    `INSERT INTO ${RETIRED_DATABASE_TOUCHES} (datname, schemaname, relname)
     SELECT $1, t.schemaname, t.relname
     FROM unnest($2::text[], $3::text[]) AS t(schemaname, relname)
     UNION ALL SELECT $1, NULL, NULL`,
    [name, touched.map((row) => row.schemaname), touched.map((row) => row.relname)],
  );
}

/** Ledger rows for databases whose names start with `test_<prefix>_`. */
export async function readRetiredDatabaseTouches(admin: Pool, prefix: string): Promise<RetiredTouch[]> {
  return readLedger(admin, "starts_with(datname, $1)", `test_${prefix}_`);
}

/** Ledger rows for the one database `name`. */
export async function readRetiredDatabaseTouchesOf(admin: Pool, name: string): Promise<RetiredTouch[]> {
  return readLedger(admin, "datname = $1", name);
}

async function readLedger(
  admin: Pool,
  condition: "starts_with(datname, $1)" | "datname = $1",
  value: string,
): Promise<RetiredTouch[]> {
  const exists = await admin.query<{ ledger: string | null }>("SELECT to_regclass($1)::text AS ledger", [
    RETIRED_DATABASE_TOUCHES,
  ]);
  if (exists.rows[0]?.ledger == null) return [];
  const rows = await admin.query<{
    datname: string;
    schemaname: string | null;
    relname: string | null;
  }>(
    `SELECT datname, schemaname, relname FROM ${RETIRED_DATABASE_TOUCHES}
     WHERE ${condition}`,
    [value],
  );
  return rows.rows.map((row) => ({
    databaseName: row.datname,
    schemaName: row.schemaname,
    tableName: row.relname,
  }));
}

/** Concurrent first writers can race on CREATE ... IF NOT EXISTS; the loser's error is harmless. */
async function ensureLedger(admin: Pool): Promise<void> {
  try {
    await admin.query(
      `CREATE TABLE IF NOT EXISTS ${RETIRED_DATABASE_TOUCHES} (
         datname text NOT NULL,
         schemaname text,
         relname text
       )`,
    );
  } catch (error) {
    if (!isDuplicateObject(error)) throw error;
  }
}

function isDuplicateObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return typeof code === "string" && DUPLICATE_OBJECT_CODES.has(code);
}
