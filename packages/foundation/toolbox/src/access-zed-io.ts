/** Shared filesystem helpers for reading `.zed` schemas and writing artifacts. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMissingPathError } from "./missing-path-error.js";

/** Read a `.zed` schema file from disk with clear, actionable errors. */
export function readZedFile(inputPath: string): string {
  try {
    return readFileSync(inputPath, "utf8");
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new Error(`Zed schema file not found: ${inputPath}.`, {
        cause: error,
      });
    }
    const detail =
      error instanceof Error ? error.message : "Unable to read file.";
    throw new Error(`Unable to read zed schema file ${inputPath}: ${detail}`, {
      cause: error,
    });
  }
}

/** Write generated output to `outPath`, creating parent directories unless `dryRun`. */
export function writeTextArtifact(
  outPath: string | null,
  content: string,
  dryRun: boolean,
): boolean {
  if (outPath === null || dryRun) {
    return false;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf8");
  return true;
}
