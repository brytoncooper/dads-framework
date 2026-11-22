/** CLI command handlers for `dad access`. */

import { diffAccessSources, type ZedSchemaDiffResult } from "./access-diff.js";
import { formatAccessDiffReport } from "./access-diff-format.js";
import {
  importZedSchema,
  type ZedSchemaImportResult,
} from "./access-import.js";
import {
  scaffoldAccessMigrationFromSources,
  type AccessMigrationScaffoldResult,
} from "./access-migrate.js";
import { renderAccessTree, type AccessTreeResult } from "./access-tree.js";
import {
  parseAccessDiffArguments,
  parseAccessImportArguments,
  parseAccessMigrateArguments,
  parseAccessTreeArguments,
} from "./cli-access-args.js";
import { writeOutput } from "./cli-io.js";

const ACCESS_USAGE = [
  "Usage: dad access import <schema.zed> [--out <path>] [--style <ergonomic|classic>] [--dry-run] [--json]",
  "       dad access tree <schema.ts|schema.zed> [--json]",
  "       dad access diff <before> <after> [--json]",
  "       dad access migrate <slug> --from <before> --to <after> [--out <dir>] [--dry-run] [--json]",
].join("\n");

export async function accessCommand(
  args: readonly string[],
  json: boolean,
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "import") {
    runImport(rest, json);
    return;
  }
  if (subcommand === "tree") {
    await runTree(rest, json);
    return;
  }
  if (subcommand === "diff") {
    await runDiff(rest, json);
    return;
  }
  if (subcommand === "migrate") {
    await runMigrate(rest, json);
    return;
  }
  throw new Error(ACCESS_USAGE);
}

function runImport(rest: readonly string[], json: boolean): void {
  const parsed = parseAccessImportArguments(rest);
  const result = importZedSchema({
    inputPath: parsed.inputPath,
    ...(parsed.outPath !== undefined ? { outPath: parsed.outPath } : {}),
    ...(parsed.style !== undefined ? { style: parsed.style } : {}),
    dryRun: parsed.dryRun,
    cwd: process.cwd(),
  });
  writeAccessImportOutput(result, json);
}

async function runTree(rest: readonly string[], json: boolean): Promise<void> {
  const parsed = parseAccessTreeArguments(rest);
  const result = await renderAccessTree({
    inputPath: parsed.inputPath,
    cwd: process.cwd(),
  });
  writeAccessTreeOutput(result, json);
}

async function runDiff(rest: readonly string[], json: boolean): Promise<void> {
  const parsed = parseAccessDiffArguments(rest);
  const result = await diffAccessSources({
    beforePath: parsed.beforePath,
    afterPath: parsed.afterPath,
    cwd: process.cwd(),
  });
  writeAccessDiffOutput(result, json);
}

async function runMigrate(
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  const parsed = parseAccessMigrateArguments(rest);
  const result = await scaffoldAccessMigrationFromSources({
    slug: parsed.slug,
    fromPath: parsed.fromPath,
    toPath: parsed.toPath,
    ...(parsed.outDir !== undefined ? { outDir: parsed.outDir } : {}),
    dryRun: parsed.dryRun,
    cwd: process.cwd(),
  });
  writeAccessMigrateOutput(result, json);
}

function writeAccessImportOutput(
  result: ZedSchemaImportResult,
  json: boolean,
): void {
  if (json) {
    writeOutput({ ok: true, ...result }, true);
    return;
  }
  if (result.outPath === null) {
    process.stdout.write(result.code);
    return;
  }
  const noun = result.definitionCount === 1 ? "definition" : "definitions";
  const list =
    result.definitions.length > 0 ? ` (${result.definitions.join(", ")})` : "";
  const verb = result.written ? "Imported" : "Dry run: would import";
  process.stdout.write(
    `${verb} ${String(result.definitionCount)} ${noun}${list} to ${result.outPath}\n`,
  );
}

function writeAccessTreeOutput(result: AccessTreeResult, json: boolean): void {
  if (json) {
    writeOutput({ ok: true, ...result }, true);
    return;
  }
  if (result.tree.length > 0) {
    process.stdout.write(`${result.tree}\n`);
  }
}

function writeAccessDiffOutput(
  result: ZedSchemaDiffResult,
  json: boolean,
): void {
  if (json) {
    writeOutput(
      {
        ok: true,
        beforePath: result.beforePath,
        afterPath: result.afterPath,
        ...result.diff,
      },
      true,
    );
    return;
  }
  process.stdout.write(formatAccessDiffReport(result.diff));
}

function writeAccessMigrateOutput(
  result: AccessMigrationScaffoldResult,
  json: boolean,
): void {
  if (json) {
    writeOutput({ ok: true, ...result }, true);
    return;
  }
  const verb = result.written ? "Scaffolded" : "Dry run: would scaffold";
  const migrationFlag = result.requiresMigration ? "true" : "false";
  process.stdout.write(
    `${verb} migration ${result.id} at ${result.filePath}\n` +
      `requiresMigration: ${migrationFlag}\n` +
      `${result.diff.summary}\n`,
  );
}
