import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestPool } from "../testing/create-test-pool.js";
import { readRetiredDatabaseTouchesOf } from "../testing/global-setup/retired-database-touches.js";
import {
  createPrivateDatabase,
  startUnmigratedTestPostgres,
  type TestPostgres,
} from "../testing/start-test-postgres.js";

describe("shared test database retirement", () => {
  // Undefined until setup succeeds, so a failed boot reports its own error
  // instead of a teardown crash stacked on top of it.
  let server: TestPostgres | undefined;

  // Under CONTAINER_PER_FILE=1 this boots a whole Postgres container instead
  // of creating a database on the shared one, which outruns Vitest's 10s
  // default hook timeout on a loaded runner. Same budget as the sibling suites.
  beforeAll(async () => {
    server = await startUnmigratedTestPostgres({ attributed: false });
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("closes its pool and connections, refuses reconnects, and leaves its neighbor available", async () => {
    if (server === undefined) throw new Error("Postgres did not start");
    const database = await createPrivateDatabase(server.connectionString, {
      attributed: false,
    });
    const neighbor = await createPrivateDatabase(server.connectionString, {
      attributed: false,
    });
    const external = createTestPool(database.connectionString, {
      attributed: false,
    });
    const reconnect = createTestPool(database.connectionString, {
      attributed: false,
    });
    const client = await external.connect();
    const clientErrors: Error[] = [];
    client.on("error", (error: Error) => clientErrors.push(error));
    const clientEnded = new Promise<void>((resolve) => {
      client.once("end", resolve);
    });

    try {
      const connected = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const pid = connected.rows[0]?.pid;
      if (pid === undefined) throw new Error("Expected an external backend");
      await database.pool.query("SELECT 1");
      await neighbor.pool.query(
        "CREATE TABLE retirement_probe (value integer)",
      );
      await neighbor.pool.query("INSERT INTO retirement_probe VALUES (42)");

      // A run that attached to a shared container gets that container's
      // storage, so ask the server rather than this process's env.
      const droppedOnStop =
        (
          await server.pool.query<{ fsync: string }>(
            "SELECT current_setting('fsync') AS fsync",
          )
        ).rows[0]?.fsync === "off";
      await database.stop();
      await clientEnded;

      const databaseName = new URL(database.connectionString).pathname.slice(1);
      const metadata = await server.pool.query<{ datallowconn: boolean }>(
        "SELECT datallowconn FROM pg_database WHERE datname = $1",
        [databaseName],
      );
      // On disk a stopped database is kept until the container goes; in RAM
      // it is dropped at once (test-postgres-storage.ts).
      expect(metadata.rows).toEqual(
        droppedOnStop ? [] : [{ datallowconn: false }],
      );
      expect(database.pool.ended).toBe(true);
      expect(database.pool.totalCount).toBe(0);
      expect(clientErrors).toContainEqual(
        expect.objectContaining({ code: "57P01" }),
      );
      const remaining = await server.pool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      expect(remaining.rows).toEqual([]);
      // 55000: connections disallowed (disk). 3D000: database gone (RAM).
      await expect(reconnect.query("SELECT 1")).rejects.toMatchObject({
        code: droppedOnStop ? "3D000" : "55000",
      });
      expect(
        (
          await neighbor.pool.query<{ value: number }>(
            "SELECT value FROM retirement_probe",
          )
        ).rows,
      ).toEqual([{ value: 42 }]);
    } finally {
      client.release(true);
      await external.end();
      await reconnect.end();
      if (!database.pool.ended) await database.stop();
      await neighbor.stop();
    }
  });

  it("shuts out a pool the file leaked for good, and still records what that pool touched", async () => {
    if (server === undefined) throw new Error("Postgres did not start");
    const database = await createPrivateDatabase(server.connectionString, {
      attributed: false,
    });
    const databaseName = new URL(database.connectionString).pathname.slice(1);
    const leaked = createTestPool(database.connectionString, {
      attributed: false,
      maxConnections: 1,
    });
    // Asks for a connection the whole time stop() runs. Once a stopped
    // database has refused it, it must never serve it again: re-allowing
    // connections ahead of the RAM drop let a leaked pool back in, and the
    // DROP ... WITH (FORCE) then killed it mid-query (57P01).
    const outcomes: string[] = [];
    const asking = { stopping: true };
    const askAgainAndAgain = (async () => {
      while (asking.stopping) {
        try {
          await leaked.query("SELECT 1");
          outcomes.push("served");
        } catch (error) {
          outcomes.push(errorCode(error));
        }
      }
    })();

    try {
      await leaked.query("CREATE TABLE leaked_probe (value integer)");
      await leaked.query("INSERT INTO leaked_probe VALUES (1)");
      const droppedOnStop =
        (
          await server.pool.query<{ fsync: string }>(
            "SELECT current_setting('fsync') AS fsync",
          )
        ).rows[0]?.fsync === "off";

      await database.stop();
      asking.stopping = false;
      await askAgainAndAgain;

      const firstRefusal = outcomes.findIndex(
        (outcome) => outcome !== "served",
      );
      expect(firstRefusal).toBeGreaterThanOrEqual(0);
      expect(outcomes.slice(firstRefusal)).not.toContain("served");
      if (droppedOnStop) {
        // Terminated, not closed, and its counters still reach the ledger.
        const admin = createTestPool(
          withDatabase(server.connectionString, "postgres"),
          { attributed: false },
        );
        try {
          expect(
            await readRetiredDatabaseTouchesOf(admin, databaseName),
          ).toEqual(
            expect.arrayContaining([
              {
                databaseName,
                schemaName: "public",
                tableName: "leaked_probe",
              },
            ]),
          );
        } finally {
          await admin.end();
        }
      } else {
        const metadata = await server.pool.query<{ datallowconn: boolean }>(
          "SELECT datallowconn FROM pg_database WHERE datname = $1",
          [databaseName],
        );
        expect(metadata.rows).toEqual([{ datallowconn: false }]);
      }
    } finally {
      asking.stopping = false;
      await askAgainAndAgain;
      await leaked.end();
      if (!database.pool.ended) await database.stop();
    }
  });
});

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "no-code";
  }
  return typeof error.code === "string" ? error.code : "no-code";
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
