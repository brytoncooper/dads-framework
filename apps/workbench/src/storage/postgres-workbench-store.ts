import type { DrizzleHandle } from "@dads-framework/postgres";
import type { PostgresAuthorization } from "@dads-framework/postgres-access";
import { withProtectedDrizzleTransaction } from "@dads-framework/postgres-access/drizzle";
import { sql } from "drizzle-orm";
import { readPostgresTaskCandidates } from "./read-postgres-task-candidates.js";

import {
  applyWorkbenchRelationships,
  checkWorkbenchPermission,
} from "../operations/workbench-authorization.js";
import { WorkbenchError } from "../operations/workbench-error.js";
import {
  POSTGRES_WORKBENCH_SCHEMA_VERSION,
  POSTGRES_WORKBENCH_STATE_TABLE,
} from "./postgres-workbench-schema.js";
import {
  SnapshotWorkbenchStore,
  type SameStoreAuthorizedWorkbenchMutation,
  type SameStoreAuthorizingWorkbenchStore,
  type WorkbenchMutation,
} from "./workbench-store.js";
import { workbenchState, type WorkbenchState } from "./workbench-state.js";

type Transaction = Parameters<Parameters<DrizzleHandle["transaction"]>[0]>[0];

export type PostgresWorkbenchStoreOptions = {
  readonly database: Pick<DrizzleHandle, "execute" | "transaction">;
  readonly authorization: PostgresAuthorization;
  readonly namespace: string;
};

const stateTable = sql.identifier(POSTGRES_WORKBENCH_STATE_TABLE);

/** Application state and relationship facts use one primary-database transaction. */
export class PostgresWorkbenchStore
  extends SnapshotWorkbenchStore
  implements SameStoreAuthorizingWorkbenchStore
{
  constructor(private readonly options: PostgresWorkbenchStoreOptions) {
    super();
  }

  override read(): Promise<WorkbenchState> {
    return readState(this.options.database, this.options.namespace, false);
  }

  override readTaskCandidates(workspaceId: string) {
    return readPostgresTaskCandidates(
      this.options.database,
      this.options.namespace,
      workspaceId,
    );
  }

  override transaction<Result>(
    change: (state: WorkbenchState) => Result,
  ): Promise<Result> {
    return this.withLockedState(async (tx, _authorization, state) => {
      const result = change(state);
      await writeState(tx, this.options.namespace, state);
      return result;
    });
  }

  override commitMutation<Result>(
    mutation: (state: WorkbenchState) => WorkbenchMutation<Result>,
  ): Promise<Result> {
    return this.withLockedState((tx, authorization, state) =>
      this.persistMutation(tx, authorization, state, mutation(state)),
    );
  }

  commitAuthorizedMutation<Result>(
    request: SameStoreAuthorizedWorkbenchMutation<Result>,
  ): Promise<Result> {
    return this.withLockedState(async (tx, authorization, state) => {
      const target = request.authorization.target(state);
      if (
        target === undefined &&
        request.authorization.kind !== "fresh-create"
      ) {
        throw new Error(
          "A protected Workbench mutation must resolve an authorization target.",
        );
      }
      if (
        target !== undefined &&
        !(await checkWorkbenchPermission(authorization, {
          ...target,
          subject: request.subject,
        }))
      )
        throw new WorkbenchError("NOT_FOUND");
      return this.persistMutation(
        tx,
        authorization,
        state,
        request.mutation(state),
      );
    });
  }

  private withLockedState<Result>(
    work: (
      tx: Transaction,
      authorization: PostgresAuthorization,
      state: WorkbenchState,
    ) => Promise<Result>,
  ): Promise<Result> {
    return withProtectedDrizzleTransaction(
      {
        database: this.options.database,
        authorization: this.options.authorization,
      },
      async ({ tx, authorization }) =>
        work(
          tx,
          authorization,
          await readState(tx, this.options.namespace, true),
        ),
    );
  }

  private async persistMutation<Result>(
    tx: Transaction,
    authorization: PostgresAuthorization,
    state: WorkbenchState,
    mutation: WorkbenchMutation<Result>,
  ): Promise<Result> {
    for (const change of mutation.authorizationChanges) {
      await applyWorkbenchRelationships(authorization, change);
    }
    await writeState(tx, this.options.namespace, state);
    return mutation.result;
  }
}

async function readState(
  database: Pick<DrizzleHandle, "execute">,
  namespace: string,
  lock: boolean,
): Promise<WorkbenchState> {
  const result = await database.execute<{
    schema_version: unknown;
    document: unknown;
  }>(sql`
    SELECT schema_version, document FROM ${stateTable} WHERE namespace = ${namespace}
    ${lock ? sql`FOR UPDATE` : sql.empty()}
  `);
  const row = result.rows[0];
  if (
    row === undefined ||
    row.schema_version !== POSTGRES_WORKBENCH_SCHEMA_VERSION
  ) {
    throw new Error(
      "Postgres Workbench state is missing or has an unsupported schema version.",
    );
  }
  const document: unknown =
    typeof row.document === "string" ? JSON.parse(row.document) : row.document;
  return workbenchState.parse(document);
}

async function writeState(
  database: Pick<DrizzleHandle, "execute">,
  namespace: string,
  state: WorkbenchState,
): Promise<void> {
  const document = JSON.stringify(workbenchState.parse(state));
  const result = await database.execute(sql`
    UPDATE ${stateTable} SET document = ${document}::jsonb
    WHERE namespace = ${namespace} AND schema_version = ${POSTGRES_WORKBENCH_SCHEMA_VERSION}
  `);
  if (result.rowCount !== 1)
    throw new Error(
      "Postgres Workbench state disappeared during its transaction.",
    );
}
