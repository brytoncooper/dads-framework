import { sql, type SQL } from "drizzle-orm";
import type { DrizzleExecuteLike } from "./drizzle-structural.js";
import type { PostgresAccessExecutor } from "./postgres-authorization.js";
import type { PostgresQuery } from "./postgres-types.js";

/** Bridge compiled, numbered placeholders to the transaction's bound Drizzle parameters. */
export function transactionExecutor(
  transaction: DrizzleExecuteLike,
): PostgresAccessExecutor {
  return {
    query(query: PostgresQuery) {
      return transaction.execute(parameterized(query));
    },
  };
}

function parameterized(query: PostgresQuery): SQL {
  const parts: SQL[] = [];
  let start = 0;
  for (const match of query.text.matchAll(/\$(\d+)/g)) {
    const ordinal = Number(match[1]);
    if (ordinal < 1 || ordinal > (query.values?.length ?? 0)) {
      throw new Error(
        "Postgres authorization SQL references a missing parameter",
      );
    }
    parts.push(sql.raw(query.text.slice(start, match.index)));
    parts.push(sql`${sql.param(query.values?.[ordinal - 1])}`);
    start = match.index + match[0].length;
  }
  parts.push(sql.raw(query.text.slice(start)));
  return sql.join(parts);
}
