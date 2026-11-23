import type { AccessModel } from "@dads-framework/access";
import type { ColumnRelationBinding } from "./policy/column-relations.js";
import type { DrizzleExecuteLike } from "./drizzle-structural.js";
import type { PgPoolLike, PostgresQuery, PostgresQueryResult } from "./postgres-types.js";
import { isPreparedCheckExecutorForPool } from "./prepared-check-executor.js";

type DrizzleExecutorModule = {
  readonly transactionExecutor: (transaction: DrizzleExecuteLike) => PostgresAccessExecutor;
};

let drizzleExecutorModulePromise: Promise<DrizzleExecutorModule> | undefined;

export function lazyDrizzleTransactionExecutor(transaction: DrizzleExecuteLike): PostgresAccessExecutor {
  return {
    async query(query: PostgresQuery): Promise<PostgresQueryResult> {
      drizzleExecutorModulePromise ??= import("./drizzle-executor.js");
      const { transactionExecutor } = await drizzleExecutorModulePromise;
      return transactionExecutor(transaction).query(query);
    },
  };
}

export type PostgresAccessExecutor = {
  query(query: PostgresQuery): PromiseLike<PostgresQueryResult>;
  queryCheck?(query: PostgresQuery): PromiseLike<PostgresQueryResult>;
};

export type PostgresAccessOptions = {
  readonly model: AccessModel;
  readonly namespace: string;
  readonly executor: PostgresAccessExecutor;
  readonly queryTimeoutMs?: number;
  /** The same managed, primary autocommit pool passed as executor. Requires the optional revision migration. */
  readonly reuseLookupResultsOn?: PgPoolLike;
  /**
   * Bind single-target FK relations directly to columns on application tables
   * (e.g. `documents.org_id`, `folders.parent_id`, `documents.owner_id`) so
   * authorization reads those columns directly with zero dual-writes.
   */
  readonly columnRelations?: readonly ColumnRelationBinding[];
};

export function validatePostgresAccessOptions(options: PostgresAccessOptions): number {
  if (options.namespace.trim() === "") {
    throw new Error("Postgres authorization namespace is required");
  }
  const timeout = options.queryTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("Postgres authorization queryTimeoutMs must be a positive integer");
  }
  if (options.reuseLookupResultsOn !== undefined) {
    validateLookupReusePool(options, options.reuseLookupResultsOn);
  }
  return timeout;
}

function validateLookupReusePool(options: PostgresAccessOptions, reusePool: PgPoolLike): void {
  if (options.columnRelations !== undefined && options.columnRelations.length > 0) {
    throw new Error(
      "Postgres lookup reuse cannot be combined with columnRelations because revision triggers only observe the relationship table",
    );
  }
  if (
    typeof reusePool.connect !== "function" ||
    (reusePool !== options.executor && !isPreparedCheckExecutorForPool(reusePool, options.executor))
  ) {
    throw new Error("Postgres lookup reuse requires the same primary pool as the executor");
  }
}
