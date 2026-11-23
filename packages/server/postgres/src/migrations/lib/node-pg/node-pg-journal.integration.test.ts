// The checksum journal must commit with the schema change. A later
// failure, a rewritten applied file, a database-ahead name, or a missing
// build file is refused by migration id — never by database URL.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationWorkspace } from "../../index.js";

import {
  NODE_PG_APPLIED_TABLE,
  NODE_PG_CHECKSUM_TABLE,
  NODE_PG_JOURNAL_SCHEMA,
  NodePgMigrationJournalError,
  runNodePgMigrations,
} from "../../index.js";
import { startUnmigratedTestPostgres } from "../../../testing/index.js";
import type { TestPostgres } from "../../../testing/index.js";

const ORGANIZATIONS_MIGRATIONS = "packages/server/organizations/src/lib/database/migrations";

let postgresHandle: TestPostgres | undefined;

describe("node-pg checksum journal", () => {
  let postgres: TestPostgres;
  let workspaceRoot: string | undefined;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    postgresHandle = postgres;
  }, 120_000);

  afterEach(async () => {
    await postgres.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await postgres.pool.query("CREATE SCHEMA public");
    await postgres.pool.query(`DROP SCHEMA IF EXISTS "${NODE_PG_JOURNAL_SCHEMA}" CASCADE`);
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await postgres.stop();
  });

  it("writes the checksum in the same apply as the schema change", async () => {
    workspaceRoot = await writeWorkspace({
      "20260828120000_probe.migration.ts": reversibleTable("20260828120000", "journal_probe"),
    });

    await runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });

    expect(await publicTables()).toEqual(["journal_probe"]);
    expect(await appliedNames()).toEqual(["20260828120000_probe.migration"]);
    expect(await checksumNames()).toEqual(["20260828120000_probe.migration"]);
  });

  it("is a no-op on a second invocation", async () => {
    workspaceRoot = await writeWorkspace({
      "20260828120000_probe.migration.ts": reversibleTable("20260828120000", "journal_probe"),
    });
    await runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
    await runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });

    expect(await appliedNames()).toEqual(["20260828120000_probe.migration"]);
    expect(await checksumNames()).toEqual(["20260828120000_probe.migration"]);
  });

  it("rolls schema and checksums back when a later migration fails", async () => {
    workspaceRoot = await writeWorkspace({
      "20260828120000_keep.migration.ts": reversibleTable("20260828120000", "journal_keep"),
      "20260828120001_fail.migration.ts": failingMigration(),
    });

    await expect(
      runNodePgMigrations({
        databaseUrl: postgres.connectionString,
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toThrow("intentional-node-pg-journal-failure");

    expect(await publicTables()).toEqual([]);
    expect(await appliedNames()).toEqual([]);
    expect(await checksumNames()).toEqual([]);
  });

  it("refuses a changed applied file without logging the database url", async () => {
    workspaceRoot = await writeWorkspace({
      "20260828120000_probe.migration.ts": reversibleTable("20260828120000", "journal_probe"),
    });
    await runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
    await writeFile(
      join(workspaceRoot, ORGANIZATIONS_MIGRATIONS, "20260828120000_probe.migration.ts"),
      reversibleTable("20260828120000", "journal_probe_changed"),
    );

    let error: unknown;
    try {
      await runNodePgMigrations({
        databaseUrl: postgres.connectionString,
        workspace: defaultMigrationWorkspace(workspaceRoot),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NodePgMigrationJournalError);
    if (!(error instanceof NodePgMigrationJournalError)) {
      return;
    }
    expect(error.code).toBe("NODE_PG_MIGRATION_CHECKSUM_MISMATCH");
    expect(error.migrationId).toBe("20260828120000_probe.migration");
    expect(error.message).not.toContain(postgres.connectionString);
    expect(error.message).not.toContain("CREATE TABLE");
  });

  it("refuses an unknown database-ahead entry", async () => {
    workspaceRoot = await writeWorkspace({
      "20260828120000_probe.migration.ts": reversibleTable("20260828120000", "journal_probe"),
    });
    await runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
    await postgres.pool.query(
      `ALTER TABLE "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}"
       DISABLE TRIGGER dads_node_pg_checksums_on_apply`,
    );
    await postgres.pool.query(
      `INSERT INTO "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}" (name, run_on)
       VALUES ('20260828129999_ghost.migration', NOW())`,
    );

    await expect(
      runNodePgMigrations({
        databaseUrl: postgres.connectionString,
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_DATABASE_AHEAD",
      migrationId: "20260828129999_ghost.migration",
    });
  });

  it("refuses an applied file missing from the build", async () => {
    workspaceRoot = await writeWorkspace({
      "20260828120000_probe.migration.ts": reversibleTable("20260828120000", "journal_probe"),
    });
    await runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
    await rm(join(workspaceRoot, ORGANIZATIONS_MIGRATIONS, "20260828120000_probe.migration.ts"));

    await expect(
      runNodePgMigrations({
        databaseUrl: postgres.connectionString,
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_DATABASE_AHEAD",
    });
  });
});

async function writeWorkspace(files: Record<string, string>): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "node-pg-journal-"));
  const folder = join(workspaceRoot, ORGANIZATIONS_MIGRATIONS);
  await mkdir(folder, { recursive: true });
  // Discovery refuses a tree missing either library root, because a root that
  // moved and a root with no migrations in it used to look the same to it.
  // A fixture without both would be testing that refusal.
  await mkdir(join(workspaceRoot, "packages/server"), {
    recursive: true,
  });
  await Promise.all(Object.entries(files).map(([fileName, contents]) => writeFile(join(folder, fileName), contents)));
  return workspaceRoot;
}

function reversibleTable(_id: string, tableName: string): string {
  return `export function up(pgm) {
  pgm.sql("CREATE TABLE ${tableName} (id integer PRIMARY KEY)");
}
export function down(pgm) {
  pgm.sql("DROP TABLE ${tableName}");
}
`;
}

function failingMigration(): string {
  return `export function up() {
  throw new Error("intentional-node-pg-journal-failure");
}
export function down() {}
`;
}

async function publicTables(): Promise<string[]> {
  const postgres = currentPostgres();
  const result = await postgres.pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return result.rows.map((row) => row.tablename);
}

async function appliedNames(): Promise<string[]> {
  const postgres = currentPostgres();
  const exists = await postgres.pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
     ) AS exists`,
    [NODE_PG_JOURNAL_SCHEMA, NODE_PG_APPLIED_TABLE],
  );
  if (exists.rows[0]?.exists !== true) {
    return [];
  }
  const result = await postgres.pool.query<{ name: string }>(
    `SELECT name FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_APPLIED_TABLE}" ORDER BY name`,
  );
  return result.rows.map((row) => row.name);
}

async function checksumNames(): Promise<string[]> {
  const postgres = currentPostgres();
  const exists = await postgres.pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
     ) AS exists`,
    [NODE_PG_JOURNAL_SCHEMA, NODE_PG_CHECKSUM_TABLE],
  );
  if (exists.rows[0]?.exists !== true) {
    return [];
  }
  const result = await postgres.pool.query<{ name: string }>(
    `SELECT name FROM "${NODE_PG_JOURNAL_SCHEMA}"."${NODE_PG_CHECKSUM_TABLE}" ORDER BY name`,
  );
  return result.rows.map((row) => row.name);
}

function currentPostgres(): TestPostgres {
  if (postgresHandle === undefined) {
    throw new Error("test postgres was not started");
  }
  return postgresHandle;
}
