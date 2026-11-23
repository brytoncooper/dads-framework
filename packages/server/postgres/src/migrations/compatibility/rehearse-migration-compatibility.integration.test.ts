import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { defaultMigrationWorkspace } from "../index.js";

import { RehearsalPostgres } from "../../testing/index.js";
import { rehearseMigrationCompatibility } from "./rehearse-migration-compatibility.js";

const FOLDER = "packages/server/probe/src/lib/database/migrations";
const LEGACY = "20250101000000_baseline.migration";
const A = "20260101000000_alpha.migration";
const B = "20260102000000_beta.migration";

describe("real migration arrival compatibility", () => {
  let postgres: RehearsalPostgres;
  let workspaceRoot: string;
  const write = async (
    name: string,
    sql: string,
    dependsOn?: readonly string[],
  ) => {
    await writeFile(
      join(workspaceRoot, FOLDER, `${name}.ts`),
      (dependsOn === undefined
        ? ""
        : `export const dependsOn = ${JSON.stringify(dependsOn)};\n`) +
        `export function up(pgm) { pgm.sql(${JSON.stringify(sql)}); }\nexport const down = false;\n`,
    );
  };
  const rehearse = () =>
    rehearseMigrationCompatibility({
      workspace: defaultMigrationWorkspace(workspaceRoot),
      baselineNames: [LEGACY],
      postgres,
    });

  let stopPostgres: (() => Promise<void>) | undefined;

  // Role and settings fingerprints need a cluster this suite owns outright,
  // so it starts its own rather than sharing the test run's Postgres.
  beforeAll(async () => {
    const started = await RehearsalPostgres.start();
    postgres = started.postgres;
    stopPostgres = started.stop;
  }, 120_000);
  afterAll(async () => {
    await stopPostgres?.();
  });
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "migration-arrival-test-"));
    await mkdir(join(workspaceRoot, FOLDER), { recursive: true });
    await mkdir(join(workspaceRoot, "packages/server"), {
      recursive: true,
    });
    await write(
      LEGACY,
      "CREATE TABLE kept (id integer PRIMARY KEY, value text); INSERT INTO kept VALUES (1, 'retained')",
    );
  });
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("accepts independent additions in both orders while retaining baseline rows", async () => {
    await write(A, "ALTER TABLE kept ADD COLUMN alpha integer DEFAULT 1", []);
    await write(B, "ALTER TABLE kept ADD COLUMN beta text DEFAULT 'b'", []);
    expect(await rehearse()).toMatchObject({ orders: 2, pending: 2 });
  });

  it("refuses successful SQL whose data depends on arrival order", async () => {
    await write(A, "UPDATE kept SET value = 'alpha'", []);
    await write(B, "UPDATE kept SET value = 'beta'", []);
    await expect(rehearse()).rejects.toThrow(/compatibility differs/);
  });

  it("refuses an undeclared backfill-before-rename dependency", async () => {
    await write(A, "UPDATE kept SET value = 'backfilled'", []);
    await write(B, "ALTER TABLE kept RENAME COLUMN value TO renamed", []);
    await expect(rehearse()).rejects.toMatchObject({ code: "42703" });
  });

  it("accepts the backfill and rename when their real dependency is declared", async () => {
    await write(A, "UPDATE kept SET value = 'backfilled'", []);
    await write(B, "ALTER TABLE kept RENAME COLUMN value TO renamed", [A]);
    expect(await rehearse()).toMatchObject({ orders: 1, pending: 2 });
  });

  it("returns no work for a fully applied baseline", async () => {
    expect(await rehearse()).toEqual({
      orders: 0,
      pending: 0,
      baselineMs: 0,
      replayMs: 0,
      baselineRowsByRelation: {},
    });
  });

  it("checks every order when two samples would conceal a three-way data conflict", async () => {
    await write(
      LEGACY,
      "CREATE TABLE kept (value integer); INSERT INTO kept VALUES (0)",
    );
    await write(A, "UPDATE kept SET value = value + 1", []);
    await write(B, "UPDATE kept SET value = value * 2", []);
    await write(
      "20260103000000_gamma.migration",
      "UPDATE kept SET value = value + 1",
      [],
    );
    await expect(rehearse()).rejects.toThrow(/compatibility differs/);
  });

  it("resolves a directory support import without changing its source", async () => {
    const support = join(workspaceRoot, FOLDER, "support");
    await mkdir(support);
    await writeFile(
      join(support, "index.ts"),
      'export const sql = "CREATE TABLE alpha (value integer)";',
    );
    await writeFile(
      join(workspaceRoot, FOLDER, `${A}.ts`),
      'import { sql } from "./support"; export const dependsOn = []; export function up(pgm) { pgm.sql(sql); } export const down = false;',
    );
    expect(await rehearse()).toMatchObject({ orders: 1, pending: 1 });
  });

  it("refuses cluster-role changes rather than leaking them between arrival attempts", async () => {
    const role = `rehearsal_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({
      connectionString: postgres.connectionString,
    });
    await admin.connect();
    try {
      await write(A, `CREATE ROLE "${role}"`, []);
      await expect(rehearse()).rejects.toThrow(/cluster roles/);
    } finally {
      try {
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await admin.end();
      }
    }
  });

  it("refuses a template outside the owned rehearsal databases", async () => {
    await expect(postgres.createDatabase("postgres")).rejects.toThrow(
      /isolated run/,
    );
  });
});
