import type {
  PostgresAccessExecutor,
  PostgresAuthorization,
} from "./postgres-authorization.js";

type Lifetime = {
  owner: object | undefined;
  active(): boolean;
};

const lifetimes = new WeakMap<PostgresAuthorization, Lifetime>();

export function assertProtectedAuthorizationActive(
  authorization: PostgresAuthorization,
): void {
  const scope = lifetimes.get(authorization);
  if (scope !== undefined && !scope.active()) {
    throw scopeEnded();
  }
}

export function assertProtectedAuthorizationCanJoin(
  authorization: PostgresAuthorization,
  owner: object | undefined,
): void {
  const scope = lifetimes.get(authorization);
  if (scope === undefined) return;
  if (!scope.active()) throw scopeEnded();
  if (scope.owner !== owner) {
    throw new Error(
      "Protected authorization can only join its own Postgres transaction",
    );
  }
}

export function openProtectedAuthorizationScope(
  authorization: PostgresAuthorization,
  owner: object,
  innerExecutor: PostgresAccessExecutor,
): {
  readonly authorization: PostgresAuthorization;
  readonly close: () => void;
} {
  assertProtectedAuthorizationCanJoin(authorization, owner);
  const parent = lifetimes.get(authorization);
  let executor: PostgresAccessExecutor | undefined = innerExecutor;
  const scope: Lifetime = {
    owner,
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
      scope.owner = undefined;
    },
  };
}

function scopeEnded(): Error {
  return new Error("Protected Postgres authorization scope has ended");
}
