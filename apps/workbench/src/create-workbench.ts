import type { DrizzleHandle } from "@dads-framework/postgres";
import type { PostgresAuthorization } from "@dads-framework/postgres-access";
import { PostgresWorkbenchStore } from "./storage/postgres-workbench-store.js";
import type { WorkbenchAuthorization } from "./access.js";
import type { WorkbenchStore } from "./storage/workbench-store.js";
import { createWorkbenchOperations } from "./operations/workbench-operations.js";
import { createWorkbenchRoutes } from "./routes.js";

export type WorkbenchOptions = {
  readonly store: WorkbenchStore;
  readonly authorization: WorkbenchAuthorization;
  readonly clock: () => string;
  readonly createId: () => string;
};

/** Composes the same guarded operations for every runtime and test. */
export function createWorkbench(options: WorkbenchOptions) {
  const operations = createWorkbenchOperations(options);
  return {
    routes: createWorkbenchRoutes(operations),
    operations,
    authorization: options.authorization,
  };
}

/** Compose business writes and relationship updates against the same Postgres transaction. */
export function createPostgresWorkbench(
  options: Omit<WorkbenchOptions, "store" | "authorization"> & {
    readonly database: DrizzleHandle;
    readonly authorization: PostgresAuthorization;
    readonly namespace: string;
  },
) {
  return createWorkbench({
    ...options,
    store: new PostgresWorkbenchStore(options),
  });
}
