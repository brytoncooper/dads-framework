import type { DrizzleHandle } from "@dads-framework/postgres";
import { is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

import {
  assertProtectedAuthorizationCanJoin,
  openProtectedAuthorization,
} from "./protected-authorization-scope.js";
import type { PostgresAuthorization } from "./postgres-authorization.js";
import { readPostgresSerializationConflict } from "./postgres-serialization-conflict.js";

type Schema = Record<string, unknown>;
type Database<TSchema extends Schema> = Pick<
  DrizzleHandle<TSchema>,
  "transaction"
>;
type Transaction<TSchema extends Schema> = Parameters<
  Parameters<Database<TSchema>["transaction"]>[0]
>[0];

export type ProtectedPostgresTransactionOptions<
  TSchema extends Schema = Schema,
> = {
  readonly authorization: PostgresAuthorization;
} & (
  | { readonly database: Database<TSchema>; readonly transaction?: never }
  | { readonly transaction: Transaction<TSchema>; readonly database?: never }
);

export type ProtectedPostgresTransaction<TSchema extends Schema = Schema> = {
  readonly tx: Transaction<TSchema>;
  readonly authorization: PostgresAuthorization;
};

/** Run one protected write with authorization and application data on the same client. */
export async function withProtectedPostgresTransaction<
  TSchema extends Schema,
  Result,
>(
  options: ProtectedPostgresTransactionOptions<TSchema>,
  work: (scope: ProtectedPostgresTransaction<TSchema>) => Promise<Result>,
): Promise<Result> {
  try {
    assertProtectedAuthorizationCanJoin(
      options.authorization,
      options.transaction,
    );
    if (options.transaction !== undefined) {
      return await runProtectedWork(
        options.transaction,
        options.authorization,
        work,
      );
    }

    if (is(options.database, PgTransaction)) {
      throw new Error("Pass an existing Postgres transaction as transaction");
    }
    let started = false;
    return await options.database.transaction(
      (tx) => {
        if (started)
          throw new Error("Protected Postgres callbacks cannot be replayed");
        started = true;
        return runProtectedWork(tx, options.authorization, work);
      },
      { isolationLevel: "serializable" },
    );
  } catch (error) {
    const conflict = readPostgresSerializationConflict(error);
    if (conflict !== undefined) throw conflict;
    throw error;
  }
}

async function runProtectedWork<TSchema extends Schema, Result>(
  tx: Transaction<TSchema>,
  authorization: PostgresAuthorization,
  work: (scope: ProtectedPostgresTransaction<TSchema>) => Promise<Result>,
): Promise<Result> {
  if (!is(tx, PgTransaction)) {
    throw new Error("Protected Postgres writes require a Drizzle transaction");
  }
  // A SELECT takes the transaction snapshot, so isolation cannot later be lowered.
  const isolation = await tx.execute<{ isolation: unknown }>(
    sql`select current_setting('transaction_isolation') as isolation`,
  );
  if (isolation.rows[0]?.isolation !== "serializable") {
    throw new Error("Protected Postgres writes require serializable isolation");
  }

  const scope = openProtectedAuthorization(authorization, tx);
  try {
    return await work({ tx, authorization: scope.authorization });
  } finally {
    scope.close();
  }
}
