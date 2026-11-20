import type { PostgresConnection } from "@dads-framework/postgres";
import type { PostgresQuery, PostgresRow } from "./postgres-types.js";

/** An idle direct pg connection runs exactly one autocommit statement. */
export async function readFromLookupPrimary(
  pool: PostgresConnection["pool"],
  query: PostgresQuery,
  timeoutMs: number,
): Promise<readonly PostgresRow[]> {
  const client = await pool.connect();
  let destroy = true;
  try {
    // A client returned to the pool in a transaction is unsafe, including an
    // otherwise read-only transaction with a retained snapshot.
    if (client.getTransactionStatus() !== "I")
      throw new Error("Postgres lookup reuse requires an idle pool connection");
    const config: PostgresQuery = {
      ...query,
      query_timeout: timeoutMs,
    };
    const result = await client.query<PostgresRow>(config);
    if (client.getTransactionStatus() !== "I")
      throw new Error("Postgres lookup reuse did not complete in autocommit");
    destroy = false;
    return result.rows;
  } finally {
    client.release(destroy);
  }
}
