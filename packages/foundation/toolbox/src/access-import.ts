/** Import a SpiceDB `.zed` schema file into strict Dads TypeScript. */

import { resolve } from "node:path";
import { emitTypeScript, parseZed } from "@dads-framework/access";
import { readZedFile, writeTextArtifact } from "./access-zed-io.js";

export type ImportZedSchemaOptions = {
  readonly inputPath: string;
  readonly outPath?: string;
  readonly dryRun?: boolean;
  readonly cwd?: string;
};

export type ZedSchemaImportResult = {
  readonly inputPath: string;
  readonly outPath: string | null;
  readonly definitionCount: number;
  readonly definitions: readonly string[];
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly code: string;
};

/**
 * Read a SpiceDB `.zed` schema file, parse it into Dads access IR, emit strict
 * TypeScript, and optionally write the generated module to disk.
 */
export function importZedSchema(options: ImportZedSchemaOptions): ZedSchemaImportResult {
  const baseDirectory = options.cwd ?? process.cwd();
  const inputPath = resolve(baseDirectory, options.inputPath);
  const outPath = options.outPath !== undefined ? resolve(baseDirectory, options.outPath) : null;
  const dryRun = options.dryRun === true;
  const source = readZedFile(inputPath);
  const definitions = parseZed(source);
  const code = emitTypeScript(definitions);
  const written = writeTextArtifact(outPath, code, dryRun);

  return {
    inputPath,
    outPath,
    definitionCount: definitions.length,
    definitions: definitions.map((definition) => definition.wireName),
    dryRun,
    written,
    code,
  };
}
