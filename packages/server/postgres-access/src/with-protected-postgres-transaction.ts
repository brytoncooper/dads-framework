import type { PgClientLike } from "./postgres-types.js";
import {
  withProtectedPgTransaction,
  type ProtectedPgTransaction,
  type ProtectedPgTransactionOptions,
} from "./with-protected-pg-transaction.js";

export type ProtectedPostgresTransactionOptions<Client extends PgClientLike = PgClientLike> =
  ProtectedPgTransactionOptions<Client>;

export type ProtectedPostgresTransaction<Client extends PgClientLike = PgClientLike> = ProtectedPgTransaction<Client>;

/** Run one protected write on a plain `pg.Pool` with `BEGIN ISOLATION LEVEL SERIALIZABLE`. */
export function withProtectedPostgresTransaction<Client extends PgClientLike, Result>(
  options: ProtectedPostgresTransactionOptions<Client>,
  work: (scope: ProtectedPostgresTransaction<Client>) => PromiseLike<Result>,
): Promise<Result> {
  return withProtectedPgTransaction(options, work);
}
