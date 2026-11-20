import { deepEqual, equal, rejects } from "node:assert/strict";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient, PoolConfig } from "pg";

type RegisterPoolLaw = (
  name: string,
  run: (connectionString: string, observer: Pool) => Promise<void>,
) => void;

/** Applies the same connection lifecycle and isolation laws to each pool. */
export function runPostgresPoolLaws(
  open: (options: PoolConfig) => Pool,
  register: RegisterPoolLaw,
): void {
  register(
    "releases a checkout for reuse and closes the pool",
    async (connectionString) => {
      const pool = open({ connectionString, max: 1 });
      try {
        const client = await pool.connect();
        const before = await pidBeforeRelease(client);
        const after = await pool.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        equal(typeof before.rows[0]?.pid, "number");
        deepEqual(after.rows, before.rows);
      } finally {
        await pool.end();
      }
      await rejects(() => pool.query("select 1"), Error);
    },
  );

  register(
    "isolates Drizzle writes until commit and rolls back errors",
    async (connectionString, observer) => {
      const pool = open({ connectionString, max: 1 });
      try {
        await proveTransactionIsolation(drizzle(pool), observer);
      } finally {
        await pool.end();
      }
    },
  );
}

async function pidBeforeRelease(client: PoolClient) {
  try {
    return await client.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
  } finally {
    client.release();
  }
}

async function proveTransactionIsolation(
  db: ReturnType<typeof drizzle>,
  observer: Pool,
): Promise<void> {
  const refused = new Error("Rollback requested");
  await observer.query("truncate pool_conformance_writes");
  await rejects(
    () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into pool_conformance_writes values (1)`);
        const row = await tx.execute<{ value: number }>(
          sql`select value from pool_conformance_writes`,
        );
        deepEqual(row.rows, [{ value: 1 }]);
        deepEqual(await visibleWrites(observer), []);
        throw refused;
      }),
    (error) => error === refused,
  );
  deepEqual(await visibleWrites(observer), []);

  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into pool_conformance_writes values (2)`);
  });
  deepEqual(await visibleWrites(observer), [{ value: 2 }]);
}

async function visibleWrites(
  pool: Pool,
): Promise<readonly { value: number }[]> {
  const result = await pool.query<{ value: number }>(
    "select value from pool_conformance_writes order by value",
  );
  return result.rows;
}
