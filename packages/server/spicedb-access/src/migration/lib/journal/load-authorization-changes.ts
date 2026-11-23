import { resolve } from "node:path";
import { z } from "zod";

import { AuthorizationChangeError } from "../../definition-changes.mjs";
import { type AuthorizationChangeFile, loadAuthorizationChangeFiles } from "./authorization-change-files.js";
import type { AuthorizationMigrationStep } from "./journal-entry.js";

const stepSchema = z.custom<AuthorizationMigrationStep>((value) => typeof value === "function");
const hooksSchema = z
  .object({
    beforeSchemaWrite: stepSchema.optional(),
    afterSchemaWrite: stepSchema.optional(),
  })
  .strict();
const migrationModuleSchema = z.object({ migration: hooksSchema });

export type AuthorizationChangeHooks = {
  readonly beforeSchemaWrite?: AuthorizationMigrationStep;
  readonly afterSchemaWrite?: AuthorizationMigrationStep;
};
export type LoadedAuthorizationChange = AuthorizationChangeFile & AuthorizationChangeHooks;

export async function loadAuthorizationChanges(folder: string): Promise<readonly LoadedAuthorizationChange[]> {
  const changes = await loadAuthorizationChangeFiles(folder);
  const loaded: LoadedAuthorizationChange[] = [];
  for (const change of changes) {
    const hookPath = resolve(folder, change.id, "migration.ts");
    const { createJiti } = await import("jiti");
    const jiti = createJiti(hookPath, { moduleCache: false, fsCache: false });
    const hooks = migrationModuleSchema.safeParse(await jiti.import(hookPath));
    if (!hooks.success)
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change ${change.id} must export migration with optional relationship hooks`,
      );
    const { beforeSchemaWrite, afterSchemaWrite } = hooks.data.migration;
    loaded.push({
      ...change,
      ...(beforeSchemaWrite === undefined ? {} : { beforeSchemaWrite }),
      ...(afterSchemaWrite === undefined ? {} : { afterSchemaWrite }),
    });
  }
  return loaded;
}
