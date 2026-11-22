import { sql } from "drizzle-orm";

import { transactionExecutor } from "./drizzle-executor.js";
import {
  isDrizzlePgTransaction,
  type DrizzleDatabaseLike,
  type DrizzleExecuteLike,
} from "./drizzle-structural.js";
import type { PostgresAuthorization } from "./postgres-authorization.js";
import { readPostgresSerializationConflict } from "./postgres-serialization-conflict.js";
import {
  assertProtectedAuthorizationCanJoin,
  openProtectedAuthorizationScope,
} from "./protected-authorization-scope.js";

export type ProtectedDrizzleTransactionOptions<
  Tx extends DrizzleExecuteLike = DrizzleExecuteLike,
> = {
  readonly authorization: PostgresAuthorization;
} & (
  | { readonly database: DrizzleDatabaseLike<Tx>; readonly transaction?: never }
  | { readonly transaction: Tx; readonly database?: never }
);

export type ProtectedDrizzleTransaction<
  Tx extends DrizzleExecuteLike = DrizzleExecuteLike,
> = {
  readonly tx: Tx;
  readonly authorization: PostgresAuthorization;
};

/** Run one protected write with Drizzle authorization and application data on the same client. */
export async function withProtectedDrizzleTransaction<
  Tx extends DrizzleExecuteLike,
  Result,
>(
  options: ProtectedDrizzleTransactionOptions<Tx>,
  work: (scope: ProtectedDrizzleTransaction<Tx>) => Promise<Result>,
): Promise<Result> {
  try {
    assertProtectedAuthorizationCanJoin(
      options.authorization,
      options.transaction,
    );
    if (options.transaction !== undefined) {
      return await runProtectedDrizzleWork(
        options.transaction,
        options.authorization,
        work,
      );
    }

    const { database } = options;
    if (database === undefined) {
      throw new Error(
        "Protected Postgres writes require a Drizzle database or transaction",
      );
    }
    if (isDrizzlePgTransaction(database)) {
      throw new Error("Pass an existing Postgres transaction as transaction");
    }
    let started = false;
    return await database.transaction(
      (tx) => {
        if (started)
          throw new Error("Protected Postgres callbacks cannot be replayed");
        started = true;
        return runProtectedDrizzleWork(tx, options.authorization, work);
      },
      { isolationLevel: "serializable" },
    );
  } catch (error) {
    const conflict = readPostgresSerializationConflict(error);
    if (conflict !== undefined) throw conflict;
    throw error;
  }
}

async function runProtectedDrizzleWork<Tx extends DrizzleExecuteLike, Result>(
  tx: Tx,
  authorization: PostgresAuthorization,
  work: (scope: ProtectedDrizzleTransaction<Tx>) => Promise<Result>,
): Promise<Result> {
  if (!isDrizzlePgTransaction(tx)) {
    throw new Error("Protected Postgres writes require a Drizzle transaction");
  }
  // A SELECT takes the transaction snapshot, so isolation cannot later be lowered.
  const isolation = await tx.execute(
    sql`select current_setting('transaction_isolation') as isolation`,
  );
  if (isolation.rows[0]?.["isolation"] !== "serializable") {
    throw new Error("Protected Postgres writes require serializable isolation");
  }

  const scope = openProtectedAuthorizationScope(
    authorization,
    tx,
    transactionExecutor(tx),
  );
  try {
    return await work({ tx, authorization: scope.authorization });
  } finally {
    scope.close();
  }
}
