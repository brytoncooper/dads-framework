/**
 * `dad db` subcommands: `generate`, `check`, `migrate`, and `status`.
 *
 * Delegates Postgres introspection, Drizzle table generation, drift checking,
 * and migration execution to `@dads-framework/postgres` loaded dynamically from
 * the target workspace.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  loadPostgresAdapter,
  type DbIntrospectOptions,
  type DbMigrationWorkspace,
  type DbPostgresAdapter,
  type DbPostgresLoader,
  type DbTableDriftReport,
} from "./cli-db-loader.js";
import { readOption } from "./cli-io.js";
import { isRecord, isString, isUnknownArray } from "./parse-guards.js";

const DB_SUBCOMMANDS = new Set(["generate", "check", "migrate", "status"]);
const SCHEMA_OPTIONS = new Set(["--database-url", "--out", "--metadata", "--schema"]);
const MIGRATION_OPTIONS = new Set(["--database-url"]);

export type DbSubcommand = "generate" | "check" | "migrate" | "status";

type SchemaDbBase = {
  readonly databaseUrl: string;
  readonly outDir: string | undefined;
  readonly metadataPath: string | undefined;
  readonly schemas: readonly string[] | undefined;
  readonly json: boolean;
};

type MigrationDbBase = {
  readonly databaseUrl: string;
  readonly json: boolean;
};

export type ParsedDbArguments =
  | ({ readonly command: "generate" } & SchemaDbBase)
  | ({ readonly command: "check" } & SchemaDbBase)
  | ({ readonly command: "migrate" } & MigrationDbBase)
  | ({ readonly command: "status" } & MigrationDbBase);

export type RunDbCommandOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loadAdapter?: DbPostgresLoader;
  readonly stdout?: (text: string) => void;
};

type ParsedMetadataInput = {
  readonly metadata: readonly unknown[];
  readonly retiredColumns: Readonly<Record<string, readonly string[]>> | undefined;
};

type MigrationLogEvent = {
  readonly context: object;
  readonly message: string;
};

function isDbSubcommand(value: string | undefined): value is DbSubcommand {
  return value !== undefined && DB_SUBCOMMANDS.has(value);
}

function assertAllowedOptions(args: readonly string[], allowedValueOptions: ReadonlySet<string>): void {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || token === "--json") continue;
    if (allowedValueOptions.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`Unknown option ${token}.`);
    }
    throw new Error(`Unexpected argument ${token}.`);
  }
}

function resolveDatabaseUrl(optionArgs: readonly string[], env: Readonly<Record<string, string | undefined>>): string {
  const fromFlag = readOption(optionArgs, "--database-url");
  const raw = fromFlag ?? env["DATABASE_URL"];
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("DATABASE_URL is required (pass --database-url <url> or set DATABASE_URL).");
  }
  return raw.trim();
}

function parseSchemasOption(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const schemas = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (schemas.length === 0) {
    throw new Error("--schema requires at least one non-empty schema name.");
  }
  return schemas;
}

/** Parses arguments after `dad db` and resolves the database connection string. */
export function parseDbArguments(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ParsedDbArguments {
  const [subcommand, ...rest] = args;
  if (!isDbSubcommand(subcommand)) {
    throw new Error("Usage: dad db <generate|check|migrate|status> [--database-url <url>] [--json]");
  }
  const json = rest.includes("--json");
  if (subcommand === "generate" || subcommand === "check") {
    assertAllowedOptions(rest, SCHEMA_OPTIONS);
    return {
      command: subcommand,
      databaseUrl: resolveDatabaseUrl(rest, env),
      outDir: readOption(rest, "--out"),
      metadataPath: readOption(rest, "--metadata"),
      schemas: parseSchemasOption(readOption(rest, "--schema")),
      json,
    };
  }
  assertAllowedOptions(rest, MIGRATION_OPTIONS);
  return {
    command: subcommand,
    databaseUrl: resolveDatabaseUrl(rest, env),
    json,
  };
}

function parseRetiredColumns(value: unknown, metadataPath: string): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid retiredColumns in ${metadataPath}: expected an object mapping table names to string arrays.`,
    );
  }
  const result: Record<string, readonly string[]> = {};
  for (const [key, columns] of Object.entries(value)) {
    if (!isUnknownArray(columns) || !columns.every(isString)) {
      throw new Error(`Invalid retiredColumns["${key}"] in ${metadataPath}: expected an array of column names.`);
    }
    result[key] = columns;
  }
  return result;
}

function loadTableMetadata(cwd: string, metadataPath: string): ParsedMetadataInput {
  const absolutePath = resolve(cwd, metadataPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Table metadata file not found: ${absolutePath}.`);
  }
  const parsed: unknown = JSON.parse(readFileSync(absolutePath, "utf8"));
  if (Array.isArray(parsed)) {
    return { metadata: parsed, retiredColumns: undefined };
  }
  if (isRecord(parsed) && isUnknownArray(parsed["tables"])) {
    const retired = parsed["retiredColumns"];
    return {
      metadata: parsed["tables"],
      retiredColumns: retired === undefined ? undefined : parseRetiredColumns(retired, absolutePath),
    };
  }
  throw new Error(`Invalid table metadata file ${absolutePath}: expected a JSON array or { tables: [...] }.`);
}

function resolveOutputTargets(
  cwd: string,
  outDir: string | undefined,
): { readonly outputRoot: string; readonly defaultOutputDir: string | undefined } {
  if (outDir === undefined) {
    return { outputRoot: cwd, defaultOutputDir: undefined };
  }
  if (isAbsolute(outDir)) {
    return { outputRoot: outDir, defaultOutputDir: undefined };
  }
  return { outputRoot: cwd, defaultOutputDir: outDir };
}

function buildIntrospectOptions(
  cwd: string,
  parsed: Extract<ParsedDbArguments, { readonly command: "generate" | "check" }>,
  defaultOutputDir: string | undefined,
): DbIntrospectOptions {
  const loadedMetadata = parsed.metadataPath === undefined ? undefined : loadTableMetadata(cwd, parsed.metadataPath);
  return {
    ...(parsed.schemas === undefined ? {} : { schemas: parsed.schemas }),
    ...(defaultOutputDir === undefined ? {} : { defaultOutputDir }),
    ...(loadedMetadata === undefined ? {} : { metadata: loadedMetadata.metadata }),
    ...(loadedMetadata?.retiredColumns === undefined ? {} : { retiredColumns: loadedMetadata.retiredColumns }),
  };
}

function selectMigrationWorkspace(cwd: string, adapter: DbPostgresAdapter): DbMigrationWorkspace {
  const hasServerPackages = existsSync(join(cwd, "packages", "server"));
  const hasDomains = existsSync(join(cwd, "domains"));
  if (hasServerPackages && !hasDomains) {
    return adapter.defaultMigrationWorkspace(cwd);
  }
  return adapter.applicationMigrationWorkspace(cwd);
}

function writeResult(
  stdout: (text: string) => void,
  payload: object,
  humanLines: readonly string[],
  json: boolean,
): void {
  stdout(json ? `${JSON.stringify(payload)}\n` : `${humanLines.join("\n")}\n`);
}

async function runGenerate(
  cwd: string,
  parsed: Extract<ParsedDbArguments, { readonly command: "generate" | "check" }>,
  adapter: DbPostgresAdapter,
  stdout: (text: string) => void,
): Promise<number> {
  const { outputRoot, defaultOutputDir } = resolveOutputTargets(cwd, parsed.outDir);
  const options = buildIntrospectOptions(cwd, parsed, defaultOutputDir);
  const client = await adapter.connectPostgresClient(parsed.databaseUrl);
  let files;
  try {
    files = await adapter.introspectAndGenerateTables(client, options);
  } finally {
    await client.end();
  }
  const written = await adapter.writeGeneratedTableFiles(files, outputRoot);
  const tableCount = files.reduce((sum, file) => sum + file.tables.length, 0);
  const payload = {
    ok: true,
    command: "generate",
    outputRoot,
    files: written,
    tableCount,
  };
  const humanLines = [
    `Generated ${written.length} table file${written.length === 1 ? "" : "s"} (${tableCount} table${tableCount === 1 ? "" : "s"}).`,
    ...written.map((file) => `  ${file}`),
  ];
  writeResult(stdout, payload, humanLines, parsed.json);
  return 0;
}

function formatDriftHumanLines(report: DbTableDriftReport, fileCount: number): readonly string[] {
  if (report.ok) {
    return [`Database table modules are up to date (${fileCount} file${fileCount === 1 ? "" : "s"} checked).`];
  }
  const lines = ["Database table drift detected:"];
  for (const missingFile of report.missing) {
    lines.push(`  missing: ${missingFile}`);
  }
  for (const entry of report.drifted) {
    lines.push(`  drifted: ${entry.outputFile}`);
  }
  lines.push("Run `dad db generate` to update generated table modules.");
  return lines;
}

async function runCheck(
  cwd: string,
  parsed: Extract<ParsedDbArguments, { readonly command: "generate" | "check" }>,
  adapter: DbPostgresAdapter,
  stdout: (text: string) => void,
): Promise<number> {
  const { outputRoot, defaultOutputDir } = resolveOutputTargets(cwd, parsed.outDir);
  const options = buildIntrospectOptions(cwd, parsed, defaultOutputDir);
  const client = await adapter.connectPostgresClient(parsed.databaseUrl);
  let files;
  try {
    files = await adapter.introspectAndGenerateTables(client, options);
  } finally {
    await client.end();
  }
  const report = await adapter.checkGeneratedTableFiles(files, outputRoot);
  const payload = {
    ok: report.ok,
    command: "check",
    outputRoot,
    checkedCount: files.length,
    drifted: report.drifted,
    missing: report.missing,
  };
  writeResult(stdout, payload, formatDriftHumanLines(report, files.length), parsed.json);
  return report.ok ? 0 : 1;
}

async function runDbMigrate(
  cwd: string,
  parsed: Extract<ParsedDbArguments, { readonly command: "migrate" | "status" }>,
  adapter: DbPostgresAdapter,
  stdout: (text: string) => void,
): Promise<number> {
  const workspace = selectMigrationWorkspace(cwd, adapter);
  const events: MigrationLogEvent[] = [];
  await adapter.runDatabaseMigrations(
    { databaseUrl: parsed.databaseUrl, workspace },
    {
      info(context, message) {
        events.push({ context, message });
      },
    },
  );
  const payload = {
    ok: true,
    command: "migrate",
    events,
  };
  const humanLines = events.length === 0 ? ["Database migrations complete."] : events.map((event) => event.message);
  writeResult(stdout, payload, humanLines, parsed.json);
  return 0;
}

async function runDbStatus(
  cwd: string,
  parsed: Extract<ParsedDbArguments, { readonly command: "migrate" | "status" }>,
  adapter: DbPostgresAdapter,
  stdout: (text: string) => void,
): Promise<number> {
  const workspace = selectMigrationWorkspace(cwd, adapter);
  const status = await adapter.inspectNodePgMigrations({ databaseUrl: parsed.databaseUrl, workspace });
  const shipped = await adapter.listShippedDatabaseMigrations(workspace);
  const client = await adapter.connectPostgresClient(parsed.databaseUrl);
  let applied;
  try {
    applied = await adapter.readAppliedNodePgJournal(client);
  } finally {
    await client.end();
  }
  const appliedNames = new Set(applied.map((entry) => entry.journalName));
  const pending = shipped.filter((entry) => !appliedNames.has(entry.journalName));
  const payload = {
    ok: true,
    command: "status",
    status,
    shippedCount: shipped.length,
    appliedCount: applied.length,
    pendingCount: pending.length,
    pending: pending.map((entry) => ({ journalName: entry.journalName, owner: entry.owner, file: entry.file })),
    applied: applied.map((entry) => ({
      journalName: entry.journalName,
      ranAt: entry.ranAt.toISOString(),
      sha256: entry.sha256,
    })),
  };
  const humanLines = [
    `Migration status: ${status} (${applied.length} applied, ${pending.length} pending, ${shipped.length} shipped)`,
    ...pending.map((entry) => `  pending: ${entry.journalName} (${entry.file})`),
  ];
  writeResult(stdout, payload, humanLines, parsed.json);
  return 0;
}

/** Executes a `dad db` subcommand and returns the process exit code. */
export async function runDbCommand(args: readonly string[], options: RunDbCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const parsed = parseDbArguments(args, env);
  const adapter = await (options.loadAdapter ?? loadPostgresAdapter)(cwd);

  if (parsed.command === "generate" || parsed.command === "check") {
    return parsed.command === "generate"
      ? runGenerate(cwd, parsed, adapter, stdout)
      : runCheck(cwd, parsed, adapter, stdout);
  }
  if (parsed.command === "migrate") {
    return runDbMigrate(cwd, parsed, adapter, stdout);
  }
  return runDbStatus(cwd, parsed, adapter, stdout);
}

/** CLI entrypoint invoked by `dad db ...`. */
export async function dbCommand(args: readonly string[]): Promise<number> {
  return runDbCommand(args);
}
