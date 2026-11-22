import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  emitTypeScriptFromZed,
  parseZed,
  type AccessIrDefinition,
  type AccessModel,
} from "@dads-framework/access";

import type { PgMigrationExecutor } from "../access-migrations/sql-migration-types.js";
import { buildAccessModelFromIr } from "./access-model-from-ir.js";
import {
  createAuthzedMigrationSource,
  isAuthzedV1ClientLike,
  type AuthzedV1ClientLike,
  type SpiceDbExportedTuple,
  type SpiceDbMigrationSource,
} from "./authzed-client-adapter.js";
import {
  parseImportSpiceDbArgs,
  type ImportSpiceDbCliOptions,
} from "./cli-args.js";
import {
  formatArgError,
  formatDryRunOutput,
  formatLiveJsonOutput,
  formatLiveTextOutput,
  formatParityFailureText,
  formatRuntimeError,
} from "./cli-format.js";
import {
  migrateSpiceDbToPostgres,
  type MigrateSpiceDbToPostgresResult,
} from "./migrate-spicedb-to-postgres.js";
import {
  verifySpiceDbPostgresParity,
  type ParityAuthorizationClient,
  type ParityVerificationResult,
} from "./verify-parity.js";

export type ImportSpiceDbSpiceConnection = {
  readonly source: SpiceDbMigrationSource | AuthzedV1ClientLike;
  readonly parityClient?: ParityAuthorizationClient;
  readonly close?: () => Promise<void> | void;
};

export type ImportSpiceDbPostgresConnection = {
  readonly executor: PgMigrationExecutor;
  readonly createParityClient?: (input: {
    readonly definitions: readonly AccessIrDefinition[];
    readonly model: AccessModel;
    readonly namespace: string;
  }) => Promise<ParityAuthorizationClient> | ParityAuthorizationClient;
  readonly close?: () => Promise<void> | void;
};

export type ImportSpiceDbCliConnectors = {
  readonly connectSpiceDb: (input: {
    readonly endpoint: string;
    readonly token: string;
    readonly insecure: boolean;
  }) => Promise<ImportSpiceDbSpiceConnection>;
  readonly connectPostgres: (input: {
    readonly databaseUrl: string;
  }) => Promise<ImportSpiceDbPostgresConnection>;
  readonly writeFile?: (path: string, content: string) => Promise<void>;
};

export type RunImportSpiceDbCliOptions = {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly connectors: ImportSpiceDbCliConnectors;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
};

export type RunImportSpiceDbCliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type OutputSink = {
  stdout: string;
  stderr: string;
  emitOut: (text: string) => void;
  emitErr: (text: string) => void;
};

/**
 * Run the `dads-import-spicedb` CLI flow with injectable SpiceDB, Postgres,
 * and file-writing connectors.
 */
export async function runImportSpiceDbCli(
  input: RunImportSpiceDbCliOptions,
): Promise<RunImportSpiceDbCliResult> {
  const sink = createOutputSink(input);
  const parsed = parseImportSpiceDbArgs(input.argv, input.env);

  if (parsed.kind === "help") {
    sink.emitOut(`${parsed.usage}\n`);
    return toResult(0, sink);
  }
  if (parsed.kind === "error") {
    const asJson = input.argv.includes("--json");
    sink.emitErr(formatArgError(parsed.message, parsed.usage, asJson));
    return toResult(1, sink);
  }

  return executeCliOptions(parsed.options, input.connectors, sink);
}

async function executeCliOptions(
  options: ImportSpiceDbCliOptions,
  connectors: ImportSpiceDbCliConnectors,
  sink: OutputSink,
): Promise<RunImportSpiceDbCliResult> {
  try {
    const exitCode = options.dryRun
      ? await runDryRun(options, connectors, sink)
      : await runLiveMigration(options, connectors, sink);
    return toResult(exitCode, sink);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sink.emitErr(formatRuntimeError(message, options.json));
    return toResult(1, sink);
  }
}

async function runDryRun(
  options: ImportSpiceDbCliOptions,
  connectors: ImportSpiceDbCliConnectors,
  sink: OutputSink,
): Promise<number> {
  const spiceConn = await connectors.connectSpiceDb({
    endpoint: options.endpoint,
    token: options.token,
    insecure: options.insecure,
  });
  try {
    const source = isAuthzedV1ClientLike(spiceConn.source)
      ? createAuthzedMigrationSource(spiceConn.source)
      : spiceConn.source;
    const { schemaText, zedToken } = await source.readSchema();
    if (schemaText.trim() === "") {
      throw new Error("SpiceDB returned an empty schema");
    }
    const definitions = parseZed(schemaText);
    const generatedTypeScript = emitTypeScriptFromZed(schemaText);
    sink.emitOut(
      formatDryRunOutput({
        options,
        definitions,
        zedToken,
        generatedTypeScript,
      }),
    );
    return 0;
  } finally {
    await spiceConn.close?.();
  }
}

async function runLiveMigration(
  options: ImportSpiceDbCliOptions,
  connectors: ImportSpiceDbCliConnectors,
  sink: OutputSink,
): Promise<number> {
  const databaseUrl = options.databaseUrl;
  if (databaseUrl === undefined) {
    throw new Error("Postgres URL is required for live migration");
  }
  const spiceConn = await connectors.connectSpiceDb({
    endpoint: options.endpoint,
    token: options.token,
    insecure: options.insecure,
  });
  let pgConn: ImportSpiceDbPostgresConnection | undefined;
  try {
    pgConn = await connectors.connectPostgres({ databaseUrl });
    return await migrateAndReport(options, connectors, spiceConn, pgConn, sink);
  } finally {
    await pgConn?.close?.();
    await spiceConn.close?.();
  }
}

async function migrateAndReport(
  options: ImportSpiceDbCliOptions,
  connectors: ImportSpiceDbCliConnectors,
  spiceConn: ImportSpiceDbSpiceConnection,
  pgConn: ImportSpiceDbPostgresConnection,
  sink: OutputSink,
): Promise<number> {
  const collectedTuples: SpiceDbExportedTuple[] = [];
  const migration = await migrateSpiceDbToPostgres({
    spiceDb: spiceConn.source,
    postgres: pgConn.executor,
    namespace: options.namespace,
    ...(options.batchSize === undefined
      ? {}
      : { batchSize: options.batchSize }),
    ...(options.verify
      ? { onBatch: (batch) => collectedTuples.push(...batch) }
      : {}),
  });

  if (options.out !== undefined) {
    await writeGeneratedModel(
      options.out,
      migration.generatedTypeScript,
      connectors.writeFile,
    );
  }

  const parity = options.verify
    ? await runParityCheck(
        options,
        migration,
        collectedTuples,
        spiceConn,
        pgConn,
      )
    : undefined;
  return emitMigrationOutcome(options, migration, parity, sink);
}

async function runParityCheck(
  options: ImportSpiceDbCliOptions,
  migration: MigrateSpiceDbToPostgresResult,
  tuples: readonly SpiceDbExportedTuple[],
  spiceConn: ImportSpiceDbSpiceConnection,
  pgConn: ImportSpiceDbPostgresConnection,
): Promise<ParityVerificationResult> {
  if (spiceConn.parityClient === undefined) {
    throw new Error("SpiceDB connector does not provide a parity client");
  }
  if (pgConn.createParityClient === undefined) {
    throw new Error("Postgres connector does not provide a parity client");
  }
  const model = buildAccessModelFromIr(migration.definitions);
  const pgParityClient = await pgConn.createParityClient({
    definitions: migration.definitions,
    model,
    namespace: options.namespace,
  });
  return verifySpiceDbPostgresParity({
    spiceDb: spiceConn.parityClient,
    postgres: pgParityClient,
    definitions: migration.definitions,
    tuples,
  });
}

function emitMigrationOutcome(
  options: ImportSpiceDbCliOptions,
  migration: MigrateSpiceDbToPostgresResult,
  parity: ParityVerificationResult | undefined,
  sink: OutputSink,
): number {
  const hasMismatches = parity !== undefined && parity.mismatches.length > 0;
  if (options.json) {
    sink.emitOut(
      formatLiveJsonOutput(options, migration, parity, !hasMismatches),
    );
    return hasMismatches ? 1 : 0;
  }

  sink.emitOut(formatLiveTextOutput(options, migration, parity));
  if (hasMismatches) {
    sink.emitErr(formatParityFailureText(parity));
    return 1;
  }
  return 0;
}

async function writeGeneratedModel(
  outPath: string,
  content: string,
  customWriteFile:
    ((path: string, content: string) => Promise<void>) | undefined,
): Promise<void> {
  if (customWriteFile !== undefined) {
    await customWriteFile(outPath, content);
    return;
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, content, "utf8");
}

function createOutputSink(input: RunImportSpiceDbCliOptions): OutputSink {
  const sink: OutputSink = {
    stdout: "",
    stderr: "",
    emitOut(text) {
      sink.stdout += text;
      input.writeStdout?.(text);
    },
    emitErr(text) {
      sink.stderr += text;
      input.writeStderr?.(text);
    },
  };
  return sink;
}

function toResult(
  exitCode: number,
  sink: OutputSink,
): RunImportSpiceDbCliResult {
  return { exitCode, stdout: sink.stdout, stderr: sink.stderr };
}
