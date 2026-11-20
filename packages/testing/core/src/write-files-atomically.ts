import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

export type FileOutput = {
  readonly path: string;
  readonly contents: string;
};

/**
 * Writes every output through a unique temporary file and renames each into
 * place, so a reader never observes a half-written file. A failure at any point
 * removes every temporary file this call created and rethrows.
 */
export function writeFilesAtomically(outputs: readonly FileOutput[]): void {
  const temporaryPaths: string[] = [];
  try {
    for (const output of outputs) {
      const temporaryPath = `${output.path}.${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, output.contents, "utf8");
      temporaryPaths.push(temporaryPath);
    }
    for (const [index, output] of outputs.entries()) {
      const temporaryPath = temporaryPaths[index];
      if (temporaryPath === undefined) continue;
      renameSync(temporaryPath, output.path);
    }
  } catch (error: unknown) {
    for (const temporaryPath of temporaryPaths) {
      rmSync(temporaryPath, { force: true });
    }
    throw error;
  }
}
