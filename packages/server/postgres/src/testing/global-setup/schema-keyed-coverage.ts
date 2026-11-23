/**
 * Whether an integration suite's Nx hash covers every table it touched.
 *
 * Integration suites can hash every migration file in the workspace. A suite
 * that opts into SCHEMA KEYING hashes, instead, the generated table modules of
 * the tables it touches (each prints its table's schema fingerprint) plus one
 * shared-state file for everything outside tables (functions, grants, seeded
 * rows). That is only sound if the list of table modules really is the list
 * of tables the suite reaches — directly, through a dependency's code, or
 * through a trigger or function the database runs on its behalf.
 *
 * Postgres counts every scan, insert, update, delete and truncate per table,
 * so after a run the suite's private databases say exactly which tables it
 * reached. This module compares that against what the suite's `project.json`
 * declares. A miss fails the run, which is what stops a suite from replaying
 * a cached pass after a table it reads changed underneath it
 * (docs/testing/speed.md#schema-keyed-integration-suites).
 */

/** The named input that marks a project's `test:integration` as schema-keyed. */
export const SCHEMA_KEYED_INPUT = "databaseSharedState";

/** The input a suite that reads the migrations themselves must hash instead. */
export const ALL_MIGRATIONS_INPUT = "databaseMigrations";

/** The migration runner records its journal in this schema. */
const MIGRATION_JOURNAL_SCHEMA = "dads_migration";

const TABLE_MODULE_GLOB = /^\{workspaceRoot\}\/(.+\/generated-tables)\/\*\.tables\.ts$/;

export type TouchedTable = {
  readonly schemaName: string;
  readonly tableName: string;
};

export type SchemaKeyedDeclaration = {
  /** True when the target lists {@link SCHEMA_KEYED_INPUT}. */
  readonly schemaKeyed: boolean;
  /** `generated-tables` folders the target hashes, workspace-relative. */
  readonly tableModuleFolders: readonly string[];
};

/** Reads a `test:integration` target's `inputs` as a declaration. */
export function readSchemaKeyedDeclaration(inputs: readonly unknown[] | undefined): SchemaKeyedDeclaration {
  const strings = (inputs ?? []).filter((input): input is string => typeof input === "string");
  return {
    schemaKeyed: strings.includes(SCHEMA_KEYED_INPUT),
    tableModuleFolders: strings
      .map((input) => TABLE_MODULE_GLOB.exec(input)?.[1])
      .filter((folder): folder is string => folder !== undefined),
  };
}

/** The `inputs` line that makes a suite hash one folder of table modules. */
export function tableModuleInput(folder: string): string {
  return `{workspaceRoot}/${folder}/*.tables.ts`;
}

export type CoverageInput = {
  readonly declaration: SchemaKeyedDeclaration;
  /** Table name → the `generated-tables` folder whose module declares it. */
  readonly tableOwners: ReadonlyMap<string, string>;
  readonly touched: readonly TouchedTable[];
  /** Private databases this run created WITHOUT the migrated template. */
  readonly unmigratedDatabases: number;
};

export type CoverageReport = {
  /** Folders the suite reached that its hash does not cover. */
  readonly missingFolders: readonly string[];
  /** Why the suite cannot be schema-keyed at all, if it cannot. */
  readonly needsAllMigrations: readonly string[];
  /** Every folder the suite reached, covered or not. */
  readonly reachedFolders: readonly string[];
};

export function checkSchemaKeyedCoverage(input: CoverageInput): CoverageReport {
  const declared = new Set(input.declaration.tableModuleFolders);
  const reached = new Set<string>();
  const missing = new Set<string>();
  const needsAllMigrations: string[] = [];

  if (input.unmigratedDatabases > 0) {
    needsAllMigrations.push(
      `it built ${String(input.unmigratedDatabases)} database(s) from the migrations itself (startUnmigratedTestPostgres)`,
    );
  }
  for (const table of input.touched) {
    if (table.schemaName === MIGRATION_JOURNAL_SCHEMA) {
      needsAllMigrations.push(`it read the migration journal (${table.schemaName}.${table.tableName})`);
      continue;
    }
    const folder = input.tableOwners.get(table.tableName);
    if (folder === undefined) continue;
    reached.add(folder);
    if (!declared.has(folder)) missing.add(folder);
  }

  return {
    missingFolders: [...missing].sort(),
    needsAllMigrations,
    reachedFolders: [...reached].sort(),
  };
}

/** The failure a schema-keyed suite reports, with the exact fix. */
export function describeCoverageFailure(project: string, report: CoverageReport): string | null {
  if (report.needsAllMigrations.length > 0) {
    return [
      `${project}:test:integration is schema-keyed (it lists "${SCHEMA_KEYED_INPUT}"), but ${report.needsAllMigrations.join("; ")}.`,
      `Such a suite reads the migrations, not just the schema they produce: list "${ALL_MIGRATIONS_INPUT}" instead of "${SCHEMA_KEYED_INPUT}" in its test:integration inputs.`,
      "See docs/testing/speed.md#schema-keyed-integration-suites.",
    ].join("\n");
  }
  if (report.missingFolders.length === 0) return null;
  return [
    `${project}:test:integration touched tables whose generated modules its Nx hash does not cover,`,
    "so a migration to them would replay this suite's cached pass. Add to its test:integration inputs:",
    ...report.missingFolders.map((folder) => `  "${tableModuleInput(folder)}",`),
    "See docs/testing/speed.md#schema-keyed-integration-suites.",
  ].join("\n");
}
