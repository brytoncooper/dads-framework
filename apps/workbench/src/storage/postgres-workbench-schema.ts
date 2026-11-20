import type { DrizzleHandle } from "@dads-framework/postgres";
import { sql } from "drizzle-orm";

import { emptyWorkbenchState } from "./workbench-state.js";

export const POSTGRES_WORKBENCH_SCHEMA_VERSION = 1;
export const POSTGRES_WORKBENCH_STATE_TABLE = "dads_workbench_state";

/** Versioned application schema owned by the Workbench. */
export const postgresWorkbenchSchemaSql = `CREATE TABLE IF NOT EXISTS ${POSTGRES_WORKBENCH_STATE_TABLE} (
  namespace TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = ${POSTGRES_WORKBENCH_SCHEMA_VERSION}),
  document JSONB NOT NULL
);`;

export async function initializePostgresWorkbenchSchema(
  database: Pick<DrizzleHandle, "execute">,
  namespace: string,
): Promise<void> {
  await database.execute(sql.raw(postgresWorkbenchSchemaSql));
  const document = JSON.stringify(emptyWorkbenchState());
  await database.execute(sql`
    INSERT INTO ${sql.identifier(POSTGRES_WORKBENCH_STATE_TABLE)} (namespace, schema_version, document)
    VALUES (${namespace}, ${POSTGRES_WORKBENCH_SCHEMA_VERSION}, ${document}::jsonb)
    ON CONFLICT (namespace) DO NOTHING
  `);
}
