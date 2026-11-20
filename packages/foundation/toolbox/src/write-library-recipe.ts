import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ManifestUpdate = {
  readonly path: string;
  readonly original: string;
  readonly data: Record<string, unknown>;
};

export function withLibraryRecipeLock<Result>(
  projectRoot: string,
  apply: () => Result,
): Result {
  const lock = join(projectRoot, ".dads-library-recipe.lock");
  mkdirSync(lock);
  try {
    return apply();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

export function writeLibraryRecipe(
  target: string,
  files: Record<string, string>,
  manifests: readonly ManifestUpdate[],
): void {
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target);
  const written: ManifestUpdate[] = [];
  try {
    for (const [path, content] of Object.entries(files)) {
      const file = join(target, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { flag: "wx" });
    }
    for (const manifest of manifests) {
      written.push(manifest);
      writeFileSync(
        manifest.path,
        JSON.stringify(manifest.data, null, 2) + "\n",
      );
    }
  } catch (error: unknown) {
    const rollbackErrors: unknown[] = [];
    for (const manifest of written.reverse()) {
      try {
        writeFileSync(manifest.path, manifest.original);
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError);
      }
    }
    rmSync(target, { recursive: true, force: true });
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Library creation failed and its manifest changes could not be fully restored.",
        { cause: error },
      );
    }
    throw error;
  }
}
