/**
 * Dynamically resolves `@dads-framework/postgres` subpaths from the target
 * workspace so `@dads-framework/toolbox` never takes a static dependency on the
 * Postgres adapter.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { isRecord } from "./parse-guards.js";

const POSTGRES_PACKAGE = "@dads-framework/postgres";
const POSTGRES_INSTALL_MESSAGE =
  "@dads-framework/postgres is required for dad db commands. Install it with: npm install @dads-framework/postgres";

type UnknownCallable = (...args: readonly unknown[]) => unknown;

export type DbPostgresClient = {
  readonly query: UnknownCallable;
  end(): Promise<void>;
};

export type DbGeneratedTableSummary = {
  readonly schema: string;
  readonly table: string;
  readonly exportSymbol: string;
  readonly fingerprint: string;
};

export type DbGeneratedTableFile = {
  readonly outputFile: string;
  readonly content: string;
  readonly tables: readonly DbGeneratedTableSummary[];
};

export type DbTableDriftEntry = {
  readonly outputFile: string;
  readonly expectedFingerprints: readonly string[];
  readonly actualFingerprints: readonly string[];
};

export type DbTableDriftReport = {
  readonly ok: boolean;
  readonly drifted: readonly DbTableDriftEntry[];
  readonly missing: readonly string[];
};

export type DbIntrospectOptions = {
  readonly schemas?: readonly string[];
  readonly metadata?: readonly unknown[];
  readonly defaultOutputDir?: string;
  readonly retiredColumns?: Readonly<Record<string, readonly string[]>>;
};

export type DbMigrationWorkspace = {
  readonly root: string;
  readonly sources: readonly unknown[];
  readonly moduleAliases: Readonly<Record<string, string>>;
};

export type DbMigrationLog = {
  info(context: object, message: string): void;
};

export type DbMigrationStatusKind = "current" | "node-pg-pending" | "legacy-pending";

export type DbShippedMigration = {
  readonly journalName: string;
  readonly owner: string;
  readonly file: string;
  readonly sha256: string;
};

export type DbAppliedMigration = {
  readonly journalName: string;
  readonly ranAt: Date;
  readonly sha256: string | null;
};

export type DbPostgresAdapter = {
  connectPostgresClient(databaseUrl: string): Promise<DbPostgresClient>;
  introspectAndGenerateTables(
    client: DbPostgresClient,
    options?: DbIntrospectOptions,
  ): Promise<readonly DbGeneratedTableFile[]>;
  writeGeneratedTableFiles(files: readonly DbGeneratedTableFile[], outputRoot: string): Promise<readonly string[]>;
  checkGeneratedTableFiles(files: readonly DbGeneratedTableFile[], outputRoot: string): Promise<DbTableDriftReport>;
  applicationMigrationWorkspace(root: string): DbMigrationWorkspace;
  defaultMigrationWorkspace(root: string): DbMigrationWorkspace;
  runDatabaseMigrations(
    input: { readonly databaseUrl: string; readonly workspace: DbMigrationWorkspace },
    log: DbMigrationLog,
  ): Promise<void>;
  inspectNodePgMigrations(input: {
    readonly databaseUrl: string;
    readonly workspace: DbMigrationWorkspace;
  }): Promise<DbMigrationStatusKind>;
  listShippedDatabaseMigrations(workspace: DbMigrationWorkspace): Promise<readonly DbShippedMigration[]>;
  readAppliedNodePgJournal(client: DbPostgresClient): Promise<readonly DbAppliedMigration[]>;
};

export type DbPostgresLoader = (cwd: string) => Promise<DbPostgresAdapter>;

const generatedTableSummarySchema = z.object({
  schema: z.string(),
  table: z.string(),
  exportSymbol: z.string(),
  fingerprint: z.string(),
});

const generatedTableFileSchema = z.object({
  outputFile: z.string(),
  content: z.string(),
  tables: z.array(generatedTableSummarySchema),
});

const tableDriftReportSchema = z.object({
  ok: z.boolean(),
  drifted: z.array(
    z.object({
      outputFile: z.string(),
      expectedFingerprints: z.array(z.string()),
      actualFingerprints: z.array(z.string()),
    }),
  ),
  missing: z.array(z.string()),
});

const migrationStatusKindSchema = z.enum(["current", "node-pg-pending", "legacy-pending"]);

const shippedMigrationSchema = z.object({
  journalName: z.string(),
  owner: z.string(),
  file: z.string(),
  sha256: z.string(),
});

const appliedMigrationSchema = z.object({
  journalName: z.string(),
  ranAt: z.instanceof(Date),
  sha256: z.string().nullable(),
});

const migrationWorkspaceSchema = z.object({
  root: z.string(),
  sources: z.array(z.unknown()),
  moduleAliases: z.record(z.string(), z.string()),
});

function isCallable(value: unknown): value is UnknownCallable {
  return typeof value === "function";
}

function isModuleNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error["code"];
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function readRequiredFunction(moduleNamespace: unknown, exportName: string, specifier: string): UnknownCallable {
  if (!isRecord(moduleNamespace)) {
    throw new Error(`Loaded module ${specifier} did not return an exports object.`);
  }
  const value = moduleNamespace[exportName];
  if (!isCallable(value)) {
    throw new Error(`Expected ${specifier} to export function ${exportName}.`);
  }
  return value;
}

function parsePostgresClient(value: unknown): DbPostgresClient {
  if (!isRecord(value) || !isCallable(value["query"]) || !isCallable(value["end"])) {
    throw new Error("connectPostgresClient did not return a Postgres client with query() and end().");
  }
  const queryFn = value["query"];
  const endFn = value["end"];
  return {
    query: (...args: readonly unknown[]) => queryFn.apply(value, [...args]),
    end: async () => {
      await Promise.resolve(endFn.apply(value, []));
    },
  };
}

/** Resolves a `@dads-framework/postgres` specifier from `cwd`, falling back to a monorepo sibling checkout. */
export function resolvePostgresModulePath(cwd: string, subpath?: string, allowFallback = true): string {
  const specifier = subpath === undefined ? POSTGRES_PACKAGE : `${POSTGRES_PACKAGE}/${subpath}`;
  const candidates = [join(cwd, "package.json")];
  if (allowFallback) {
    const toolboxManifest = new URL("../package.json", import.meta.url);
    if (existsSync(toolboxManifest)) {
      candidates.push(toolboxManifest.href);
    }
  }
  for (const anchor of candidates) {
    try {
      return createRequire(anchor).resolve(specifier);
    } catch (error: unknown) {
      if (!isModuleNotFound(error)) throw error;
    }
  }
  throw new Error(POSTGRES_INSTALL_MESSAGE);
}

async function importResolvedModule(cwd: string, subpath?: string): Promise<unknown> {
  const resolved = resolvePostgresModulePath(cwd, subpath);
  const imported: unknown = await import(pathToFileURL(resolved).href);
  return imported;
}

/** Dynamically loads the `@dads-framework/postgres` adapter modules from `cwd`. */
export async function loadPostgresAdapter(cwd: string): Promise<DbPostgresAdapter> {
  const [rootMod, schemaMod, migrationsMod, journalMod] = await Promise.all([
    importResolvedModule(cwd),
    importResolvedModule(cwd, "schema-generate"),
    importResolvedModule(cwd, "migrations"),
    importResolvedModule(cwd, "migrations/journal-status"),
  ]);

  const connectFn = readRequiredFunction(rootMod, "connectPostgresClient", POSTGRES_PACKAGE);
  const introspectFn = readRequiredFunction(
    schemaMod,
    "introspectAndGenerateTables",
    `${POSTGRES_PACKAGE}/schema-generate`,
  );
  const writeTablesFn = readRequiredFunction(
    schemaMod,
    "writeGeneratedTableFiles",
    `${POSTGRES_PACKAGE}/schema-generate`,
  );
  const checkTablesFn = readRequiredFunction(
    schemaMod,
    "checkGeneratedTableFiles",
    `${POSTGRES_PACKAGE}/schema-generate`,
  );
  const appWorkspaceFn = readRequiredFunction(
    migrationsMod,
    "applicationMigrationWorkspace",
    `${POSTGRES_PACKAGE}/migrations`,
  );
  const defaultWorkspaceFn = readRequiredFunction(
    migrationsMod,
    "defaultMigrationWorkspace",
    `${POSTGRES_PACKAGE}/migrations`,
  );
  const runMigrationsFn = readRequiredFunction(
    migrationsMod,
    "runDatabaseMigrations",
    `${POSTGRES_PACKAGE}/migrations`,
  );
  const inspectMigrationsFn = readRequiredFunction(
    migrationsMod,
    "inspectNodePgMigrations",
    `${POSTGRES_PACKAGE}/migrations`,
  );
  const listShippedFn = readRequiredFunction(
    journalMod,
    "listShippedDatabaseMigrations",
    `${POSTGRES_PACKAGE}/migrations/journal-status`,
  );
  const readJournalFn = readRequiredFunction(
    journalMod,
    "readAppliedNodePgJournal",
    `${POSTGRES_PACKAGE}/migrations/journal-status`,
  );

  return {
    connectPostgresClient: async (databaseUrl) => parsePostgresClient(await Promise.resolve(connectFn(databaseUrl))),
    introspectAndGenerateTables: async (client, options) =>
      z.array(generatedTableFileSchema).parse(await Promise.resolve(introspectFn(client, options))),
    writeGeneratedTableFiles: async (files, outputRoot) =>
      z.array(z.string()).parse(await Promise.resolve(writeTablesFn(files, outputRoot))),
    checkGeneratedTableFiles: async (files, outputRoot) =>
      tableDriftReportSchema.parse(await Promise.resolve(checkTablesFn(files, outputRoot))),
    applicationMigrationWorkspace: (root) => migrationWorkspaceSchema.parse(appWorkspaceFn(root)),
    defaultMigrationWorkspace: (root) => migrationWorkspaceSchema.parse(defaultWorkspaceFn(root)),
    runDatabaseMigrations: async (input, log) => {
      await Promise.resolve(runMigrationsFn(input, log));
    },
    inspectNodePgMigrations: async (input) =>
      migrationStatusKindSchema.parse(await Promise.resolve(inspectMigrationsFn(input))),
    listShippedDatabaseMigrations: async (workspace) =>
      z.array(shippedMigrationSchema).parse(await Promise.resolve(listShippedFn(workspace))),
    readAppliedNodePgJournal: async (client) =>
      z.array(appliedMigrationSchema).parse(await Promise.resolve(readJournalFn(client))),
  };
}
