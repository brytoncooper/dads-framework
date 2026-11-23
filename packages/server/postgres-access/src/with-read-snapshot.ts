import {
  abortPgTransaction,
  releasePgClient,
  type PgTransactionState,
} from "./pg-transaction-lifecycle.js";
import type { PostgresAuthorization } from "./postgres-authorization.js";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";
import {
  assertProtectedAuthorizationCanJoin,
  openProtectedAuthorizationScope,
} from "./protected-authorization-scope.js";

export type ReadSnapshotOptions<Client extends PgClientLike = PgClientLike> = {
  readonly pool: PgPoolLike<Client>;
  readonly authorization: PostgresAuthorization;
};

export type ReadSnapshotScope<Client extends PgClientLike = PgClientLike> = {
  readonly client: Client;
  readonly authorization: PostgresAuthorization;
};

/**
 * Run one consistent read (for example `resolveFilter` plus a paginated
 * `SELECT`) on a plain node-postgres pool using
 * `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.
 *
 * Keeps authorization pruning and the row query on the exact same PostgreSQL
 * MVCC snapshot without `SERIALIZABLE` write-conflict retry overhead, and
 * closes the scoped authorization handle as soon as the callback returns.
 */
export async function withReadSnapshot<Client extends PgClientLike, Result>(
  options: ReadSnapshotOptions<Client>,
  work: (scope: ReadSnapshotScope<Client>) => PromiseLike<Result>,
): Promise<Result> {
  assertProtectedAuthorizationCanJoin(options.authorization, undefined);
  const client = await options.pool.connect();
  const state: PgTransactionState = {
    began: false,
    committed: false,
    destroyClient: false,
  };
  try {
    return await executeReadSnapshot(
      client,
      options.authorization,
      work,
      state,
    );
  } catch (error) {
    state.destroyClient = await abortPgTransaction(client, state);
    throw error;
  } finally {
    releasePgClient(client, state.destroyClient);
  }
}

async function executeReadSnapshot<Client extends PgClientLike, Result>(
  client: Client,
  authorization: PostgresAuthorization,
  work: (scope: ReadSnapshotScope<Client>) => PromiseLike<Result>,
  state: PgTransactionState,
): Promise<Result> {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  state.began = true;
  const scope = openProtectedAuthorizationScope(authorization, client, client);
  let result: Result;
  try {
    result = await work({ client, authorization: scope.authorization });
  } finally {
    scope.close();
  }
  await client.query("COMMIT");
  state.committed = true;
  return result;
}
