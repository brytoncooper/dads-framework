import type { MigrationFolder } from "./plugin-contributions.js";
import { PluginCompositionError } from "./plugin-errors.js";

/**
 * One folder the migration runner walks, owned by the plugin that declared
 * it. Structurally a `MigrationSource` from `@dads-framework/postgres/migrations`, so
 * the host appends these to its workspace's `sources`.
 */
export type PluginMigrationSource = {
  /** Folder relative to the workspace root, POSIX separators. */
  readonly root: string;
  /** Matches that folder's own `*.migration.ts` files, nothing nested. */
  readonly files: RegExp;
  /** The plugin's name; the runner journals each file under it. */
  readonly owner: string;
  readonly required: boolean;
};

export type OwnedMigrationFolder = MigrationFolder & {
  readonly owner: string;
};

/**
 * Turn absolute plugin folders into sources relative to the app's workspace
 * root. A folder outside the root is refused: the runner resolves every
 * source under the root, and a journal name must not depend on where a
 * machine happens to keep the package.
 */
export function migrationSourcesFor(
  folders: readonly OwnedMigrationFolder[],
  workspaceRoot: string,
): readonly PluginMigrationSource[] {
  const root = withForwardSlashes(workspaceRoot);
  return folders.map((folder) => {
    const relative = relativeFolder(root, withForwardSlashes(folder.directory));
    if (relative === undefined) {
      throw new PluginCompositionError(
        `plugin ${folder.owner} keeps migrations in ${folder.directory}, which is not under the workspace root ${workspaceRoot}`,
      );
    }
    return {
      root: relative,
      files: new RegExp(`^${escapeForPattern(relative)}/[^/]+\\.migration\\.ts$`),
      owner: folder.owner,
      required: folder.required ?? true,
    };
  });
}

function withForwardSlashes(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function relativeFolder(root: string, directory: string): string | undefined {
  if (!directory.startsWith(`${root}/`)) return undefined;
  const relative = directory.slice(root.length + 1);
  return relative.split("/").includes("..") ? undefined : relative;
}

function escapeForPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}
