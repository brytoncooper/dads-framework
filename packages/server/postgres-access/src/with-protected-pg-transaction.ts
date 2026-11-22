import type { PostgresAuthorization } from "./postgres-authorization.js";
import { readPostgresSerializationConflict } from "./postgres-serialization-conflict.js";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";
import {
  assertProtectedAuthorizationCanJoin,
  openProtectedAuthorizationScope,
} from "./protected-authorization-scope.js";

export type ProtectedPgTransactionOptions<
  Client extends PgClientLike = PgClientLike,
> = {
  readonly pool: PgPoolLike<Client>;
  readonly authorization: PostgresAuthorization;
};

export type ProtectedPgTransaction<Client extends PgClientLike = PgClientLike> =
  {
    readonly client: Client;
    readonly authorization: PostgresAuthorization;
  };

/**
 * Run one protected write on a plain node-postgres pool using
 * `BEGIN ISOLATION LEVEL SERIALIZABLE` / `COMMIT` / `ROLLBACK`.
 *
 * Binds the scoped authorization handle to the checked-out client, closes
 * the scope as soon as the callback finishes, and translates PostgreSQL
 * `40001` serialization failures into `PostgresSerializationConflict`.
 */
export async function withProtectedPgTransaction<
  Client extends PgClientLike,
  Result,
>(
  options: ProtectedPgTransactionOptions<Client>,
  work: (scope: ProtectedPgTransaction<Client>) => PromiseLike<Result>,
): Promise<Result> {
  assertProtectedAuthorizationCanJoin(options.authorization, undefined);
  const client = await options.pool.connect();
  const state = { began: false, committed: false, destroyClient: false };
  try {
    return await executePgTransaction(
      client,
      options.authorization,
      work,
      state,
    );
  } catch (error) {
    state.destroyClient = await abortPgTransaction(client, state);
    const conflict = readPostgresSerializationConflict(error);
    if (conflict !== undefined) throw conflict;
    throw error;
  } finally {
    releasePgClient(client, state.destroyClient);
  }
}

type PgTransactionState = {
  began: boolean;
  committed: boolean;
  destroyClient: boolean;
};

async function executePgTransaction<Client extends PgClientLike, Result>(
  client: Client,
  authorization: PostgresAuthorization,
  work: (scope: ProtectedPgTransaction<Client>) => PromiseLike<Result>,
  state: PgTransactionState,
): Promise<Result> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
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

async function abortPgTransaction(
  client: PgClientLike,
  state: PgTransactionState,
): Promise<boolean> {
  if (!state.began) return true;
  if (state.committed) return false;
  if (isIdleClient(client)) return false;
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}

function releasePgClient(client: PgClientLike, destroy: boolean): void {
  const needsDestroy = destroy || !isIdleOrUnknownClient(client);
  client.release(needsDestroy ? true : undefined);
}

function isIdleClient(client: PgClientLike): boolean {
  return (
    typeof client.getTransactionStatus === "function" &&
    client.getTransactionStatus() === "I"
  );
}

function isIdleOrUnknownClient(client: PgClientLike): boolean {
  return (
    typeof client.getTransactionStatus !== "function" ||
    client.getTransactionStatus() === "I"
  );
}
