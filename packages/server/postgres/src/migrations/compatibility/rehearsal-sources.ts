import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import type {
  DiscoveredDomainMigration,
  MigrationWorkspace,
} from "../index.js";

import { migrationSupportFiles } from "./migration-support-files.js";

/**
 * The bytes of every migration and support file, read once from the real
 * workspace, and written into throwaway workspaces one migration at a time so
 * each arrival order sees exactly the files that order has received.
 */
export class RehearsalSources {
  private constructor(
    private readonly workspace: MigrationWorkspace,
    private readonly byName: ReadonlyMap<string, DiscoveredDomainMigration>,
    private readonly supports: readonly string[],
    private readonly files: ReadonlyMap<string, Buffer>,
  ) {}

  static async read(
    workspace: MigrationWorkspace,
    migrations: readonly DiscoveredDomainMigration[],
  ): Promise<RehearsalSources> {
    const migrationPaths = migrations.map((migration) =>
      relative(workspace.root, migration.filePath),
    );
    const supports = await migrationSupportFiles(workspace, migrationPaths);
    const files = new Map(
      await Promise.all(
        [...migrationPaths, ...supports].map(
          async (path) =>
            [path, await readFile(join(workspace.root, path))] satisfies [
              string,
              Buffer,
            ],
        ),
      ),
    );
    const byName = new Map(
      migrations.map((migration) => [migration.journalName, migration]),
    );
    return new RehearsalSources(workspace, byName, supports, files);
  }

  /** An empty workspace with every source root, the dependencies, and support files. */
  async prepareWorkspace(target: string): Promise<void> {
    for (const source of this.workspace.sources)
      await mkdir(join(target, source.root), { recursive: true });
    const modules = join(this.workspace.root, "node_modules");
    if (existsSync(modules))
      await symlink(modules, join(target, "node_modules"), "dir");
    for (const support of this.supports)
      await this.writeSource(support, target);
  }

  async addMigration(name: string, root: string): Promise<void> {
    const migration = this.byName.get(name);
    if (migration === undefined)
      throw new Error(`missing rehearsal migration ${name}`);
    await this.writeSource(
      relative(this.workspace.root, migration.filePath),
      root,
    );
  }

  private async writeSource(path: string, root: string): Promise<void> {
    if (path.startsWith("..") || isAbsolute(path))
      throw new Error("migration source is outside the selected workspace");
    const bytes = this.files.get(path);
    if (bytes === undefined)
      throw new Error(`missing rehearsal source ${path}`);
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}
