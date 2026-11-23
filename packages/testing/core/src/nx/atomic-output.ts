/**
 * Writing the import's outputs so a reader never sees half a file.
 *
 * The manifest and the report are one answer in two files, and POSIX renames
 * one path at a time: two files at two named paths cannot be replaced in one
 * step, and the names are the contract — `dads.testing.json` is what the
 * standalone tool reads. So the guarantee stops exactly where the filesystem
 * does, and is stated rather than implied.
 *
 * Each file is written to a unique temporary sibling first, and no rename
 * happens until every write has succeeded, so a write failure replaces
 * nothing. Renames then run in order, one after another: a rename failure
 * leaves the outputs before it replaced and the rest untouched. The report's
 * `manifestChecksum` is the digest of the manifest bytes, so a pair torn that
 * way is detectable by the reader that cares. Every temporary file is removed
 * either way.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

/**
 * Writes every output, or — if a rename fails partway — the outputs before the
 * one that failed, and nothing after it.
 */
export async function writeOutputsAtomically(
  outputs: readonly { readonly path: string; readonly contents: string }[],
): Promise<void> {
  const temporary = outputs.map((output) => ({
    ...output,
    temporaryPath: `${output.path}.${randomUUID()}.tmp`,
  }));
  try {
    await Promise.all(temporary.map((output) => fs.writeFile(output.temporaryPath, output.contents, "utf8")));
    for (const output of temporary) {
      await fs.rename(output.temporaryPath, output.path);
    }
  } finally {
    await Promise.all(temporary.map((output) => fs.rm(output.temporaryPath, { force: true })));
  }
}
