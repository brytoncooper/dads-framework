import { runner, PG_MIGRATE_LOCK_ID } from "node-pg-migrate";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationWorkspace } from "../../index.js";

import {
  inspectNodePgMigrations,
  runNodePgMigrations,
  stampNodePgJournalAsApplied,
} from "../../index.js";
import { NODE_PG_GRAPH_PROTOCOL } from "./node-pg-journal.js";
import { readAppliedNodePgJournal } from "../../journal-status.js";
import {
  createPrivateDatabase,
  startUnmigratedTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";

const FOLDER = "packages/server/probe/src/lib/database/migrations";
const A = "20260101120000_alpha.migration";
const B = "20260101120001_beta.migration";
const LEGACY = "20250101120000_legacy.migration";

describe("dependency migration journal", () => {
  let server: TestPostgres;
  let postgres: TestPostgres;
  let workspaceRoot: string;

  beforeAll(async () => {
    server = await startUnmigratedTestPostgres();
    return () => server.stop();
  }, 60_000);

  // A fresh database per case on this suite's server.
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "migration-graph-"));
    try {
      await mkdir(join(workspaceRoot, FOLDER), { recursive: true });
      postgres = await createPrivateDatabase(server.connectionString, {});
    } catch (error) {
      await rm(workspaceRoot, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      try {
        await postgres.stop();
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    };
  }, 60_000);

  const migrate = () =>
    runNodePgMigrations({
      databaseUrl: postgres.connectionString,
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
  const writeMigration = (
    name: string,
    sql: string,
    dependsOn?: readonly string[],
  ) =>
    writeFile(
      join(workspaceRoot, FOLDER, `${name}.ts`),
      (dependsOn === undefined
        ? ""
        : `export const dependsOn = ${JSON.stringify(dependsOn)};\n`) +
        `export function up(pgm) { pgm.sql(${JSON.stringify(sql)}); }\nexport const down = false;\n`,
    );

  it("applies an earlier independent sibling after B is deployed without replaying B or losing data", async () => {
    await writeMigration(
      LEGACY,
      "CREATE TABLE kept (id integer primary key, value text)",
    );
    await writeMigration(
      B,
      "CREATE TABLE beta (id integer primary key); INSERT INTO kept VALUES (1, 'B deployed')",
      [],
    );
    await migrate();
    await writeMigration(A, "CREATE TABLE alpha (id integer primary key)", []);

    await migrate();
    await migrate();

    expect(
      await inspectNodePgMigrations({
        databaseUrl: postgres.connectionString,
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).toBe("current");

    expect(
      (await postgres.pool.query<{ value: string }>("SELECT value FROM kept"))
        .rows,
    ).toEqual([{ value: "B deployed" }]);
    expect(
      (
        await postgres.pool.query<{ name: string }>(
          "SELECT name FROM dads_migration.dads_node_pg_migrations WHERE name IN ($1, $2) ORDER BY id",
          [A, B],
        )
      ).rows,
    ).toEqual([{ name: B }, { name: A }]);
    expect(
      (
        await postgres.pool.query<{ count: string }>(
          "SELECT count(*) FROM dads_migration.dads_node_pg_checksums WHERE name IN ($1, $2)",
          [A, B],
        )
      ).rows,
    ).toEqual([{ count: "2" }]);
  });

  it("backfills before a dependent rename even when the rename has the earlier timestamp", async () => {
    await writeMigration(
      LEGACY,
      "CREATE TABLE kept (id integer primary key, value text); INSERT INTO kept VALUES (1, NULL)",
    );
    await migrate();
    await writeMigration(B, "UPDATE kept SET value = 'preserved'", []);
    await writeMigration(A, "ALTER TABLE kept RENAME value TO renamed", [B]);
    await migrate();
    expect(
      (
        await postgres.pool.query<{ renamed: string }>(
          "SELECT renamed FROM kept",
        )
      ).rows,
    ).toEqual([{ renamed: "preserved" }]);
  });

  it("refuses a missing prerequisite before any schema SQL", async () => {
    await writeMigration(B, "CREATE TABLE must_not_exist (id integer)", [A]);
    await expect(migrate()).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_DEPENDENCY_MISSING",
    });
    await expect(
      inspectNodePgMigrations({
        databaseUrl: postgres.connectionString,
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toMatchObject({ code: "NODE_PG_MIGRATION_DEPENDENCY_MISSING" });
    expect(
      (
        await postgres.pool.query<{ table: string | null }>(
          "SELECT to_regclass('public.must_not_exist')::text AS table",
        )
      ).rows,
    ).toEqual([{ table: null }]);
  });

  it("refuses edited and missing applied migrations before applying pending SQL", async () => {
    await writeMigration(B, "CREATE TABLE beta (id integer)", []);
    await migrate();
    await writeMigration(A, "CREATE TABLE must_not_exist (id integer)", []);
    await writeMigration(B, "CREATE TABLE beta (id bigint)", []);
    await expect(migrate()).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_CHECKSUM_MISMATCH",
    });
    await rm(join(workspaceRoot, FOLDER, `${B}.ts`));
    await expect(migrate()).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_DATABASE_AHEAD",
    });
    expect(
      (
        await postgres.pool.query<{ table: string | null }>(
          "SELECT to_regclass('public.must_not_exist')::text AS table",
        )
      ).rows,
    ).toEqual([{ table: null }]);
  });

  it("makes an older timestamp runner refuse graph history before SQL", async () => {
    await writeMigration(B, "CREATE TABLE beta (id integer)", []);
    await migrate();
    await writeMigration(A, "CREATE TABLE must_not_exist (id integer)", []);
    const client = new Client({ connectionString: postgres.connectionString });
    await client.connect();
    try {
      await expect(
        runner({
          dbClient: client,
          dir: `${workspaceRoot}/${FOLDER}/*.migration.ts`,
          useGlob: true,
          direction: "up",
          migrationsTable: "dads_node_pg_migrations",
          migrationsSchema: "dads_migration",
          checkOrder: true,
          noLock: true,
          logger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        }),
      ).rejects.toThrow(/preceding already run migration/);
      expect(
        (
          await client.query<{ table: string | null }>(
            "SELECT to_regclass('public.must_not_exist')::text AS table",
          )
        ).rows,
      ).toEqual([{ table: null }]);
    } finally {
      await client.end();
    }
  });

  it("rolls back protocol marker, SQL and checksums on failure and safely resumes", async () => {
    await writeMigration(
      A,
      "CREATE TABLE alpha (id integer); INSERT INTO prerequisite VALUES (1)",
      [],
    );
    await expect(migrate()).rejects.toMatchObject({ code: "42P01" });
    expect(
      (
        await postgres.pool.query<{ table: string | null }>(
          "SELECT to_regclass('public.alpha')::text AS table",
        )
      ).rows,
    ).toEqual([{ table: null }]);
    await postgres.pool.query("CREATE TABLE prerequisite (id integer)");
    await migrate();
    await migrate();
    expect(
      (await postgres.pool.query<{ id: number }>("SELECT id FROM prerequisite"))
        .rows,
    ).toEqual([{ id: 1 }]);
  });

  describe("a file that exports ownTransaction", () => {
    const C = "20260101120002_gamma.migration";
    const writeAlone = (
      name: string,
      sql: string,
      dependsOn: readonly string[],
    ) =>
      writeFile(
        join(workspaceRoot, FOLDER, `${name}.ts`),
        `export const ownTransaction = true;\nexport const dependsOn = ${JSON.stringify(dependsOn)};\n` +
          `export function up(pgm) { pgm.sql(${JSON.stringify(sql)}); }\nexport const down = false;\n`,
      );
    const tableExists = async (name: string) =>
      (
        await postgres.pool.query<{ table: string | null }>(
          "SELECT to_regclass($1)::text AS table",
          [`public.${name}`],
        )
      ).rows[0]?.table === name;
    const applied = async () =>
      (
        await postgres.pool.query<{ name: string }>(
          "SELECT m.name FROM dads_migration.dads_node_pg_migrations m JOIN dads_migration.dads_node_pg_checksums c ON c.name = m.name WHERE m.name IN ($1, $2, $3) ORDER BY m.id",
          [A, B, C],
        )
      ).rows.map((row) => row.name);

    it("stays applied and recorded when a later file fails, and a rerun resumes", async () => {
      await writeAlone(A, "CREATE TABLE alpha (id integer)", []);
      await writeMigration(B, "CREATE TABLE beta (id integer)", [A]);
      await writeMigration(
        C,
        "CREATE TABLE gamma (id integer); INSERT INTO prerequisite VALUES (1)",
        [B],
      );

      await expect(migrate()).rejects.toMatchObject({ code: "42P01" });

      expect(await tableExists("alpha")).toBe(true);
      expect(await tableExists("beta")).toBe(false);
      expect(await tableExists("gamma")).toBe(false);
      expect(await applied()).toEqual([A]);

      await postgres.pool.query("CREATE TABLE prerequisite (id integer)");
      await migrate();

      expect(await applied()).toEqual([A, B, C]);
    });

    it("rolls back only itself on failure", async () => {
      await writeMigration(A, "CREATE TABLE alpha (id integer)", []);
      await writeAlone(
        B,
        "CREATE TABLE beta (id integer); INSERT INTO prerequisite VALUES (1)",
        [A],
      );

      await expect(migrate()).rejects.toMatchObject({ code: "42P01" });

      expect(await tableExists("alpha")).toBe(true);
      expect(await tableExists("beta")).toBe(false);
      expect(await applied()).toEqual([A]);
    });

    it("keeps files without the export in one transaction", async () => {
      await writeMigration(A, "CREATE TABLE alpha (id integer)", []);
      await writeMigration(
        B,
        "CREATE TABLE beta (id integer); INSERT INTO prerequisite VALUES (1)",
        [A],
      );

      await expect(migrate()).rejects.toMatchObject({ code: "42P01" });

      expect(await tableExists("alpha")).toBe(false);
      expect(await applied()).toEqual([]);
    });
  });

  describe("a file that exports buildsIndexesConcurrently", () => {
    const INDEX = "widgets_code_idx";
    const writeConcurrent = (
      name: string,
      body: string,
      dependsOn: readonly string[],
    ) =>
      writeFile(
        join(workspaceRoot, FOLDER, `${name}.ts`),
        `export const buildsIndexesConcurrently = true;\nexport const dependsOn = ${JSON.stringify(dependsOn)};\n` +
          `export function up(pgm) { ${body} }\nexport const down = false;\n`,
      );
    const indexState = async () =>
      (
        await postgres.pool.query<{ valid: boolean }>(
          "SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1",
          [INDEX],
        )
      ).rows.map((row) => (row.valid ? "valid" : "invalid"));
    const journaled = async (name: string) =>
      (
        await postgres.pool.query<{ name: string }>(
          "SELECT m.name FROM dads_migration.dads_node_pg_migrations m JOIN dads_migration.dads_node_pg_checksums c ON c.name = m.name WHERE m.name = $1",
          [name],
        )
      ).rows.length === 1;
    const uniqueBuild = `pgm.createIndex("widgets", "code", { name: "${INDEX}", unique: true, concurrently: true, ifNotExists: true });`;

    beforeEach(async () => {
      await writeMigration(
        LEGACY,
        "CREATE TABLE widgets (id integer primary key, code text); INSERT INTO widgets VALUES (1, 'a'), (2, 'b')",
      );
    });

    it("builds the index outside a transaction and journals it with its checksum and the protocol fence", async () => {
      await writeConcurrent(A, uniqueBuild, []);

      await migrate();

      expect(await indexState()).toEqual(["valid"]);
      expect(await journaled(A)).toBe(true);
      expect(
        await inspectNodePgMigrations({
          databaseUrl: postgres.connectionString,
          workspace: defaultMigrationWorkspace(workspaceRoot),
        }),
      ).toBe("current");

      await writeConcurrent(
        B,
        `pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"');`,
        [A],
      );
      await migrate();
      expect(await indexState()).toEqual([]);
      expect(await journaled(B)).toBe(true);
    });

    it.each([
      [
        "other DDL",
        'pgm.sql("ALTER TABLE widgets ADD COLUMN must_not_exist text");',
      ],
      [
        "a non-concurrent index",
        `pgm.createIndex("widgets", "code", { name: "${INDEX}", ifNotExists: true });`,
      ],
      [
        "a second statement behind an index",
        `pgm.sql("CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON widgets (code); ALTER TABLE widgets ADD COLUMN must_not_exist text");`,
      ],
      [
        "a direct query",
        'await pgm.db.query("ALTER TABLE widgets ADD COLUMN must_not_exist text");',
      ],
    ])("refuses %s before running any of its SQL", async (_label, body) => {
      await writeFile(
        join(workspaceRoot, FOLDER, `${A}.ts`),
        `export const buildsIndexesConcurrently = true;\nexport const dependsOn = [];\n` +
          `export async function up(pgm) { ${body} }\nexport const down = false;\n`,
      );

      await expect(migrate()).rejects.toMatchObject({
        code: "NODE_PG_MIGRATION_CONCURRENT_INDEX_STATEMENT_REFUSED",
      });

      expect(await indexState()).toEqual([]);
      expect(await journaled(A)).toBe(false);
      expect(
        (
          await postgres.pool.query<{ column: string }>(
            "SELECT column_name AS column FROM information_schema.columns WHERE table_name = 'widgets' AND column_name = 'must_not_exist'",
          )
        ).rows,
      ).toEqual([]);
    });

    it("drops the invalid index a failed build leaves, records nothing, and re-runs cleanly", async () => {
      await writeMigration(
        LEGACY,
        "CREATE TABLE widgets (id integer primary key, code text); INSERT INTO widgets VALUES (1, 'a'), (2, 'a')",
      );
      await writeConcurrent(A, uniqueBuild, []);

      await expect(migrate()).rejects.toMatchObject({ code: "23505" });
      expect(await indexState()).toEqual([]);
      expect(await journaled(A)).toBe(false);

      await postgres.pool.query("UPDATE widgets SET code = 'b' WHERE id = 2");
      await migrate();
      expect(await indexState()).toEqual(["valid"]);
      expect(await journaled(A)).toBe(true);
    });

    it("replaces an invalid index a crashed run left behind instead of skipping it", async () => {
      await migrate();
      await postgres.pool.query("UPDATE widgets SET code = 'a'");
      await expect(
        postgres.pool.query(
          `CREATE UNIQUE INDEX CONCURRENTLY ${INDEX} ON widgets (code)`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      expect(await indexState()).toEqual(["invalid"]);
      await postgres.pool.query("UPDATE widgets SET code = 'b' WHERE id = 2");
      await writeConcurrent(A, uniqueBuild, []);

      await migrate();

      expect(await indexState()).toEqual(["valid"]);
      expect(await journaled(A)).toBe(true);
    });

    it("leaves a file without the export unable to build concurrently", async () => {
      await writeMigration(
        A,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON widgets (code)`,
        [],
      );

      await expect(migrate()).rejects.toMatchObject({ code: "25001" });
      expect(await indexState()).toEqual([]);
      expect(await journaled(A)).toBe(false);
    });
  });

  it("refuses a new legacy migration after the graph protocol is sealed", async () => {
    await writeMigration(B, "CREATE TABLE beta (id integer)", []);
    await migrate();
    await writeMigration(LEGACY, "CREATE TABLE must_not_exist (id integer)");
    await expect(migrate()).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_LEGACY_HISTORY_CHANGED",
    });
  });

  it("refuses another migrator holding the vendor advisory lock and succeeds after release", async () => {
    await writeMigration(A, "CREATE TABLE alpha (id integer)", []);
    const client = new Client({ connectionString: postgres.connectionString });
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [PG_MIGRATE_LOCK_ID]);
      await expect(migrate()).rejects.toMatchObject({
        code: "NODE_PG_MIGRATION_LOCKED",
      });
      await client.query("SELECT pg_advisory_unlock($1)", [PG_MIGRATE_LOCK_ID]);
      await migrate();
    } finally {
      await client.end();
    }
  });

  it("refuses nontransactional graph work without persisting SQL or protocol state", async () => {
    await writeFile(
      join(workspaceRoot, FOLDER, `${A}.ts`),
      'export const dependsOn = [];\nexport function up(pgm) { pgm.noTransaction(); pgm.sql("CREATE TABLE alpha (id integer)"); }\nexport const down = false;\n',
    );
    await expect(migrate()).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_TRANSACTION_REQUIRED",
    });
    expect(
      (
        await postgres.pool.query<{ table: string | null }>(
          "SELECT to_regclass('public.alpha')::text AS table",
        )
      ).rows,
    ).toEqual([{ table: null }]);
    expect(
      (
        await postgres.pool.query<{ count: string }>(
          "SELECT count(*) FROM dads_migration.dads_node_pg_migrations",
        )
      ).rows,
    ).toEqual([{ count: "0" }]);
  });

  it("refuses schema-only adoption because it cannot prove graph backfills", async () => {
    await writeMigration(A, "CREATE TABLE alpha (id integer)", []);
    await expect(
      stampNodePgJournalAsApplied({
        databaseUrl: postgres.connectionString,
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_GRAPH_ADOPTION_REFUSED",
    });
    expect(
      (
        await postgres.pool.query<{ table: string | null }>(
          "SELECT to_regclass('dads_migration.dads_node_pg_migrations')::text AS table",
        )
      ).rows,
    ).toEqual([{ table: null }]);
  });

  it("reports original applied names without exposing the protocol marker", async () => {
    await writeMigration(A, "CREATE TABLE alpha (id integer)", []);
    await migrate();
    expect(
      (await readAppliedNodePgJournal(postgres.pool)).map(
        (entry) => entry.journalName,
      ),
    ).toEqual([A]);
    await postgres.pool.query(
      "DELETE FROM dads_migration.dads_node_pg_migrations WHERE name = $1",
      [NODE_PG_GRAPH_PROTOCOL],
    );
    await expect(migrate()).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_PROTOCOL_MISSING",
    });
  });

  it("refuses duplicate protocol identities in applied history", async () => {
    await writeMigration(A, "CREATE TABLE alpha (id integer)", []);
    await migrate();
    await postgres.pool.query(
      "DROP TRIGGER dads_node_pg_checksums_on_apply ON dads_migration.dads_node_pg_migrations",
    );
    await postgres.pool.query(
      "INSERT INTO dads_migration.dads_node_pg_migrations (name, run_on) VALUES ($1, NOW())",
      [NODE_PG_GRAPH_PROTOCOL],
    );
    await expect(migrate()).rejects.toMatchObject({
      code: "NODE_PG_MIGRATION_PROTOCOL_DUPLICATE",
    });
  });
});
