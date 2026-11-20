import { createJiti } from "jiti";
import { resolve } from "node:path";

import type { MigrationWorkspace } from "./migration-workspace.js";

/**
 * A runner compiled to CommonJS cannot native-`import()` a `.migration.ts`
 * file (`Unexpected token 'export'`). node-pg-migrate already loads these
 * files through jiti, so discovery uses the same loader.
 */
export async function loadDomainMigrationModule(
  filePath: string,
  workspace: MigrationWorkspace,
): Promise<unknown> {
  const absolutePath = resolve(filePath);
  const jiti = createJiti(absolutePath, {
    alias: resolvedModuleAliases(workspace),
    jsx: { runtime: "automatic" },
  });
  return jiti.import(absolutePath);
}

/** The workspace's aliases, each pointing at one source file under its root. */
function resolvedModuleAliases(
  workspace: MigrationWorkspace,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(workspace.moduleAliases).map(([moduleId, file]) => [
      moduleId,
      resolve(workspace.root, file),
    ]),
  );
}
