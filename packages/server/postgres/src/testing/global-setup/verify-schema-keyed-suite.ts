import { withDatabase } from "../with-database.js";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Pool } from "pg";

import { readRetiredDatabaseTouches } from "./retired-database-touches.js";
import {
  checkSchemaKeyedCoverage,
  describeCoverageFailure,
  readSchemaKeyedDeclaration,
  type TouchedTable,
} from "./schema-keyed-coverage.js";

/**
 * Names each private database this vitest process creates, so the teardown
 * can find exactly its own among the ones other projects made in the same
 * shared container. Set by the globalSetup; inherited by the test workers.
 */
export const TEST_DATABASE_RUN_PREFIX = "TEST_DATABASE_RUN_PREFIX";

/**
 * Write every suite's reach to this file instead of failing — how a suite's
 * table-module inputs are first written down. Never set in CI.
 */
export const RECORD_SCHEMA_KEYED_REACH = "RECORD_SCHEMA_KEYED_REACH";

const PROJECT_ROOTS = ["apps", "libs", "packages", "tests", "tools"] as const;
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", ".nx", "tmp"]);

/** `test_<prefix>_m_<uuid>` from the template, `test_<prefix>_u_<uuid>` without. */
export function privateDatabaseName(prefix: string | undefined, migrated: boolean, unique: string): string {
  return prefix === undefined || prefix === "" ? `test_${unique}` : `test_${prefix}_${migrated ? "m" : "u"}_${unique}`;
}

/**
 * Teardown check for a schema-keyed `test:integration` run: read which tables
 * this run's private databases touched and fail when the project's hash does
 * not cover one of them (schema-keyed-coverage.ts says why).
 *
 * Runs only under Nx (it needs to know whose run this is) and only on the
 * shared container. On disk every private database outlives its test file
 * and is read directly; under `TEST_POSTGRES_STORAGE=ram` a stopped database
 * is dropped, so its touches are read from the retired-database ledger
 * (retired-database-touches.ts). The per-file container mode is the nightly
 * honesty job, which never reuses a cached result.
 */
export async function verifySchemaKeyedSuite(input: {
  readonly sharedUrl: string;
  readonly prefix: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspaceRoot: string;
}): Promise<void> {
  const project = input.env["NX_TASK_TARGET_PROJECT"];
  if (project === undefined || input.env["NX_TASK_TARGET_TARGET"] !== "test:integration") {
    return;
  }
  const recordTo = input.env[RECORD_SCHEMA_KEYED_REACH];
  const declaration = readSchemaKeyedDeclaration(findIntegrationInputs(input.workspaceRoot, project));
  if (!declaration.schemaKeyed && recordTo === undefined) return;

  const { touched, unmigratedDatabases } = await readTouchedTables(input.sharedUrl, input.prefix);
  const report = checkSchemaKeyedCoverage({
    declaration,
    tableOwners: readTableOwners(input.workspaceRoot),
    touched,
    unmigratedDatabases,
  });

  if (recordTo !== undefined) {
    appendFileSync(
      recordTo,
      `${JSON.stringify({ project, unmigratedDatabases, needsAllMigrations: report.needsAllMigrations, reachedFolders: report.reachedFolders })}\n`,
    );
    return;
  }
  const failure = describeCoverageFailure(project, report);
  if (failure !== null) throw new Error(failure);
}

/**
 * A schema-keyed suite that boots its own container (no shared one, so no
 * teardown check) would pass without anyone reading what it touched. Refuse
 * it under Nx unless it is the per-file honesty mode, which never feeds the
 * cache a result another run reuses.
 */
export function refuseUnverifiableSchemaKeyedRun(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly containerPerFile: boolean;
  readonly workspaceRoot: string;
}): void {
  const project = input.env["NX_TASK_TARGET_PROJECT"];
  if (project === undefined || input.containerPerFile || input.env["NX_TASK_TARGET_TARGET"] !== "test:integration") {
    return;
  }
  const declaration = readSchemaKeyedDeclaration(findIntegrationInputs(input.workspaceRoot, project));
  if (!declaration.schemaKeyed) return;
  throw new Error(
    `${project}:test:integration is schema-keyed but started a Postgres outside the shared container, so nothing can check which tables it touched. Use the shared database Vitest global setup provided by @dads-framework/postgres/testing.`,
  );
}

async function readTouchedTables(
  sharedUrl: string,
  prefix: string,
): Promise<{ touched: TouchedTable[]; unmigratedDatabases: number }> {
  const admin = new Pool({
    connectionString: withDatabase(sharedUrl, "postgres"),
    max: 1,
  });
  const touched = new Map<string, TouchedTable>();
  let unmigratedDatabases = 0;
  try {
    const databases = (
      await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1",
        [`test_${prefix}_`],
      )
    ).rows.map((row) => row.datname);
    for (const name of databases) {
      if (name.startsWith(`test_${prefix}_u_`)) unmigratedDatabases += 1;
      await collectDatabaseTouches(admin, sharedUrl, name, touched);
    }
    unmigratedDatabases += await collectRetiredTouches(admin, prefix, touched);
  } finally {
    await admin.end();
  }
  return { touched: [...touched.values()], unmigratedDatabases };
}

async function collectRetiredTouches(admin: Pool, prefix: string, touched: Map<string, TouchedTable>): Promise<number> {
  // Databases already dropped under TEST_POSTGRES_STORAGE=ram.
  const retired = await readRetiredDatabaseTouches(admin, prefix);
  const retiredUnmigrated = new Set<string>();
  for (const row of retired) {
    if (row.databaseName.startsWith(`test_${prefix}_u_`)) {
      retiredUnmigrated.add(row.databaseName);
    }
    if (row.schemaName === null || row.tableName === null) continue;
    touched.set(`${row.schemaName}.${row.tableName}`, {
      schemaName: row.schemaName,
      tableName: row.tableName,
    });
  }
  return retiredUnmigrated.size;
}

async function collectDatabaseTouches(
  admin: Pool,
  sharedUrl: string,
  name: string,
  touched: Map<string, TouchedTable>,
): Promise<void> {
  // A file that never called stop() still holds connections whose
  // counters are only published when the backend exits.
  await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS true`);
  await admin.query("SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1", [name]);
  const pool = new Pool({
    connectionString: withDatabase(sharedUrl, name),
    max: 1,
  });
  try {
    const rows = await pool.query<{ schemaname: string; relname: string }>(`
        SELECT schemaname, relname
        FROM pg_stat_user_tables
        WHERE coalesce(seq_scan, 0) + coalesce(idx_scan, 0) + n_tup_ins
              + n_tup_upd + n_tup_del > 0
      `);
    for (const row of rows.rows) {
      touched.set(`${row.schemaname}.${row.relname}`, {
        schemaName: row.schemaname,
        tableName: row.relname,
      });
    }
  } finally {
    await pool.end();
    await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
  }
}

/** The project's own `test:integration` inputs, or undefined when it has none. */
function findIntegrationInputs(workspaceRoot: string, project: string): readonly unknown[] | undefined {
  for (const file of walk(workspaceRoot, PROJECT_ROOTS, "project.json")) {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || parsed["name"] !== project) continue;
    const targets = parsed["targets"];
    const target = isRecord(targets) ? targets["test:integration"] : undefined;
    const inputs = isRecord(target) ? target["inputs"] : undefined;
    return Array.isArray(inputs) ? inputs : undefined;
  }
  return undefined;
}

/** Table name → workspace-relative `generated-tables` folder declaring it. */
function readTableOwners(workspaceRoot: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const file of walk(workspaceRoot, PROJECT_ROOTS, ".tables.ts")) {
    const folder = relative(workspaceRoot, join(file, ".."));
    if (!folder.endsWith("/generated-tables")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/pgTable\(\s*"([a-z0-9_]+)"/g)) {
      if (match[1] !== undefined) owners.set(match[1], folder);
    }
  }
  return owners;
}

function walk(workspaceRoot: string, roots: readonly string[], suffix: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) visit(join(directory, entry.name));
      } else if (entry.name.endsWith(suffix)) {
        found.push(join(directory, entry.name));
      }
    }
  };
  for (const root of roots) visit(join(workspaceRoot, root));
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
