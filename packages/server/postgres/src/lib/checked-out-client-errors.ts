import type { Pool, PoolClient } from "pg";

/**
 * Gives every client the pool hands out an `error` listener for as long as
 * it is checked out.
 *
 * pg-pool listens for `error` only on IDLE clients. Once a client is checked
 * out — a Drizzle transaction, the owner lock's session, the audit-actor
 * stamp inside `pool.query` — nothing listens, and when the server drops the
 * connection (restart, failover, `pg_terminate_backend`) the client's
 * `'end'` handler emits `Connection terminated unexpectedly` as an `error`
 * event. An `error` event with no listener is an uncaught exception: the API
 * process dies.
 *
 * The listener only keeps the process alive. The caller still learns of the
 * failure, because the in-flight query rejects and the dead client is
 * destroyed when it is released.
 *
 * Attached on `acquire`, detached on `release`, so an idle client's error is
 * reported once — by the pool's own `error` listener — not twice.
 */
export function listenForCheckedOutClientErrors(pool: Pool, onError: (error: Error) => void): void {
  pool.on("acquire", (client: PoolClient) => {
    client.on("error", onError);
  });
  pool.on("release", (_error: Error, client: PoolClient) => {
    client.removeListener("error", onError);
  });
}
