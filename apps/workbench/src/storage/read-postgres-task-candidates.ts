import type { DrizzleHandle } from "@dads-framework/postgres";
import { sql } from "drizzle-orm";
import { taskResponse } from "../contracts.js";
import {
  POSTGRES_WORKBENCH_SCHEMA_VERSION,
  POSTGRES_WORKBENCH_STATE_TABLE,
} from "./postgres-workbench-schema.js";

const taskCandidates = taskResponse.array();

export async function readPostgresTaskCandidates(
  database: Pick<DrizzleHandle, "execute">,
  namespace: string,
  workspaceId: string,
) {
  const result = await database.execute<{ tasks: unknown }>(sql`
    SELECT jsonb_path_query_array(document,
      '$.tasks[*] ? (@.workspaceId == $workspace)'::jsonpath,
      jsonb_build_object('workspace', ${workspaceId}::text)
    ) AS tasks
    FROM ${sql.identifier(POSTGRES_WORKBENCH_STATE_TABLE)}
    WHERE namespace = ${namespace}
      AND schema_version = ${POSTGRES_WORKBENCH_SCHEMA_VERSION}
      AND document -> 'schemaVersion' = to_jsonb(schema_version)
      AND jsonb_typeof(document -> 'tasks') = 'array'
  `);
  const row = result.rows[0];
  if (row === undefined)
    throw new Error(
      "Postgres Workbench task state is missing or has an unsupported schema version.",
    );
  return taskCandidates.parse(row.tasks);
}
