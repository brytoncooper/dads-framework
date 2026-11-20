import { createHash } from "node:crypto";
import type { PostgresAccessExecutor } from "./postgres-authorization.js";
import type { PostgresQuery, PostgresQueryResult } from "./postgres-types.js";

const MAX_PREPARED_CHECK_SHAPES = 64;
const MAX_PREPARED_CHECK_BYTES = 4_096;
const MAX_PREPARED_SQL_BYTES = 32_768;

type NamedStatementExecutor = {
  query(
    query: PostgresQuery & { readonly name?: string },
  ): PromiseLike<PostgresQueryResult>;
};

const preparedExecutors = new WeakMap<
  NamedStatementExecutor,
  PostgresAccessExecutor
>();

/** Opt in to named single-check plans on a direct node-postgres pool. */
export function preparePostgresChecks(
  pool: NamedStatementExecutor,
): PostgresAccessExecutor {
  const existing = preparedExecutors.get(pool);
  if (existing !== undefined) return existing;

  const names = new Map<string, string>();
  let admittedBytes = 0;
  const executor: PostgresAccessExecutor = {
    query: (query) => pool.query(query),
    queryCheck(query) {
      let name = names.get(query.text);
      if (name === undefined) {
        // PostgreSQL keeps named plans per connection. Retain only a bounded
        // set of names rather than allocating new ones as shapes churn.
        const bytes = Buffer.byteLength(query.text);
        if (
          names.size >= MAX_PREPARED_CHECK_SHAPES ||
          bytes > MAX_PREPARED_CHECK_BYTES ||
          admittedBytes + bytes > MAX_PREPARED_SQL_BYTES
        )
          return pool.query(query);
        const hash = createHash("sha256").update(query.text).digest("hex");
        name = `dad_check_${hash.slice(0, 40)}`;
        names.set(query.text, name);
        admittedBytes += bytes;
      }
      return pool.query({ ...query, name });
    },
  };
  preparedExecutors.set(pool, executor);
  return executor;
}

export function isPreparedCheckExecutorForPool(
  pool: NamedStatementExecutor,
  executor: PostgresAccessExecutor,
): boolean {
  return preparedExecutors.get(pool) === executor;
}
