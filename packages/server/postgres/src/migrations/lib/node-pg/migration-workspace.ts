/**
 * Where a workspace keeps its migration files, and what a migration file may
 * import. The runner never guesses a layout: the caller names every folder it
 * walks and every module alias a migration resolves, so one runner serves this
 * repository's kit parts and an application's own folder alike.
 */

/** One folder the runner walks for `<utcTimestamp>_<slug>.migration.ts` files. */
export type MigrationSource = {
  /** Folder to walk, relative to the workspace root, POSIX separators. */
  readonly root: string;
  /**
   * Which walked files are migrations, matched against the path relative to
   * the workspace root. Capture group 1 is the owner unless `owner` is set.
   */
  readonly files: RegExp;
  /** A fixed owner for every file this source finds. */
  readonly owner?: string;
  /**
   * A missing required root throws: a folder that moved must not read as a
   * folder with nothing to apply. A missing optional root is skipped.
   */
  readonly required: boolean;
};

export type MigrationWorkspace = {
  /** Absolute path every source and alias is relative to. */
  readonly root: string;
  readonly sources: readonly MigrationSource[];
  /**
   * Module ids a migration file may import, each mapped to one source file
   * relative to `root`. A deployed image can ship sources without packages.
   */
  readonly moduleAliases: Readonly<Record<string, string>>;
};

/**
 * This repository's layout: every server part's
 * `src/lib/**\/migrations/` folder, owned by the part, plus an optional
 * top-level `migrations/` folder owned by the application.
 */
export function defaultMigrationWorkspace(root: string): MigrationWorkspace {
  return {
    root,
    sources: [
      {
        root: "packages/server",
        files: /^packages\/server\/([^/]+)\/src\/(?:[^/]+\/)?lib\/(?:.+\/)?migrations\/[^/]+\.migration\.ts$/,
        required: true,
      },
      {
        root: "migrations",
        files: /^migrations\/[^/]+\.migration\.ts$/,
        owner: "app",
        required: false,
      },
    ],
    moduleAliases: {},
  };
}
