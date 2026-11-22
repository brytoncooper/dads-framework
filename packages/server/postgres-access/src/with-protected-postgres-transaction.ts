import type { DrizzleExecuteLike } from "./drizzle-structural.js";
import type { PgClientLike } from "./postgres-types.js";
import type {
  ProtectedDrizzleTransaction,
  ProtectedDrizzleTransactionOptions,
  withProtectedDrizzleTransaction as withProtectedDrizzleTransactionFn,
} from "./with-protected-drizzle-transaction.js";
import {
  withProtectedPgTransaction,
  type ProtectedPgTransaction,
  type ProtectedPgTransactionOptions,
} from "./with-protected-pg-transaction.js";

export type ProtectedPostgresTransactionOptions<
  Tx extends DrizzleExecuteLike = DrizzleExecuteLike,
  Client extends PgClientLike = PgClientLike,
> =
  | (ProtectedPgTransactionOptions<Client> & {
      readonly database?: never;
      readonly transaction?: never;
    })
  | (ProtectedDrizzleTransactionOptions<Tx> & {
      readonly pool?: never;
    });

export type ProtectedPostgresTransaction<
  Tx extends DrizzleExecuteLike = DrizzleExecuteLike,
> = ProtectedDrizzleTransaction<Tx>;

type PgTransactionCall<Client extends PgClientLike, Result> = readonly [
  options: ProtectedPgTransactionOptions<Client> & {
    readonly database?: never;
    readonly transaction?: never;
  },
  work: (scope: ProtectedPgTransaction<Client>) => PromiseLike<Result>,
];

type DrizzleTransactionCall<Tx extends DrizzleExecuteLike, Result> = readonly [
  options: ProtectedDrizzleTransactionOptions<Tx> & {
    readonly pool?: never;
  },
  work: (scope: ProtectedDrizzleTransaction<Tx>) => Promise<Result>,
];

type DrizzleTransactionModule = {
  readonly withProtectedDrizzleTransaction: typeof withProtectedDrizzleTransactionFn;
};

let drizzleTransactionModulePromise:
  Promise<DrizzleTransactionModule> | undefined;

function loadDrizzleTransactionModule(): Promise<DrizzleTransactionModule> {
  drizzleTransactionModulePromise ??=
    import("./with-protected-drizzle-transaction.js");
  return drizzleTransactionModulePromise;
}

function isPgTransactionCall<
  Client extends PgClientLike,
  Tx extends DrizzleExecuteLike,
  Result,
>(
  args: PgTransactionCall<Client, Result> | DrizzleTransactionCall<Tx, Result>,
): args is PgTransactionCall<Client, Result> {
  return args[0].pool !== undefined;
}

/** Run one protected write on a plain `pg.Pool` with `BEGIN ISOLATION LEVEL SERIALIZABLE`. */
export function withProtectedPostgresTransaction<
  Client extends PgClientLike,
  Result,
>(
  options: ProtectedPgTransactionOptions<Client> & {
    readonly database?: never;
    readonly transaction?: never;
  },
  work: (scope: ProtectedPgTransaction<Client>) => PromiseLike<Result>,
): Promise<Result>;

/** Run one protected write with authorization and application data on the same Drizzle client. */
export function withProtectedPostgresTransaction<
  Tx extends DrizzleExecuteLike,
  Result,
>(
  options: ProtectedDrizzleTransactionOptions<Tx> & {
    readonly pool?: never;
  },
  work: (scope: ProtectedDrizzleTransaction<Tx>) => Promise<Result>,
): Promise<Result>;

export async function withProtectedPostgresTransaction<
  Client extends PgClientLike,
  Tx extends DrizzleExecuteLike,
  Result,
>(
  ...args:
    PgTransactionCall<Client, Result> | DrizzleTransactionCall<Tx, Result>
): Promise<Result> {
  if (isPgTransactionCall(args)) {
    return withProtectedPgTransaction(args[0], args[1]);
  }
  const { withProtectedDrizzleTransaction } =
    await loadDrizzleTransactionModule();
  return withProtectedDrizzleTransaction(args[0], args[1]);
}
