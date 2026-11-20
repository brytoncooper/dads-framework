import type { DrizzleHandle } from "@dads-framework/postgres";

import { transactionExecutor } from "./drizzle-executor.js";
import type {
  PostgresAccessExecutor,
  PostgresAuthorization,
} from "./postgres-authorization.js";

type TransactionIdentity = Pick<DrizzleHandle, "execute">;
type Lifetime = {
  transaction: TransactionIdentity | undefined;
  active(): boolean;
};

const lifetimes = new WeakMap<PostgresAuthorization, Lifetime>();

export function assertProtectedAuthorizationCanJoin(
  authorization: PostgresAuthorization,
  tx: TransactionIdentity | undefined,
): void {
  const scope = lifetimes.get(authorization);
  if (scope === undefined) return;
  if (!scope.active()) throw scopeEnded();
  if (scope.transaction !== tx) {
    throw new Error(
      "Protected authorization can only join its own Postgres transaction",
    );
  }
}

export function openProtectedAuthorization(
  authorization: PostgresAuthorization,
  tx: TransactionIdentity,
) {
  assertProtectedAuthorizationCanJoin(authorization, tx);
  const parent = lifetimes.get(authorization);
  let executor: PostgresAccessExecutor | undefined = transactionExecutor(tx);
  const scope: Lifetime = {
    transaction: tx,
    active: () => executor !== undefined && (parent?.active() ?? true),
  };
  const scoped = authorization.inTransaction({
    query(query) {
      if (executor === undefined || !scope.active()) {
        return Promise.reject(scopeEnded());
      }
      return executor.query(query);
    },
  });
  lifetimes.set(scoped, scope);
  return {
    authorization: scoped,
    close() {
      executor = undefined;
      scope.transaction = undefined;
    },
  };
}

function scopeEnded(): Error {
  return new Error("Protected Postgres authorization scope has ended");
}
