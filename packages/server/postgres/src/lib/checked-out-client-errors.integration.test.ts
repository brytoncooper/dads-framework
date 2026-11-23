import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestPostgres, type TestPostgres } from "../testing/start-test-postgres.js";
import { createPostgresConnection } from "./create-postgres-connection.js";

/**
 * What: a client checked out of the production pool survives the server
 * killing its connection — the failure is a log line, not an uncaught
 * exception.
 *
 * Why against a real server: the crash is pg's own `'error'` emission when
 * Postgres terminates a backend (restart, failover, a test stopping its
 * database). Only a real backend termination proves the listener is on the
 * client at the moment pg emits.
 */
describe("checked-out client errors (integration)", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startTestPostgres();
  }, 180_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it("logs, instead of crashing on, a checked-out client whose backend is terminated", async () => {
    const logged: object[] = [];
    const connection = createPostgresConnection(
      { schema: {}, connectionString: postgres.connectionString },
      { error: (value) => logged.push(value) },
    );
    const client = await connection.pool.connect();
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = backend.rows[0]?.pid;
    expect(pid).toBeTypeOf("number");

    await postgres.pool.query("select pg_terminate_backend($1)", [pid]);

    await vi.waitFor(() => {
      expect(logged).toContainEqual(expect.objectContaining({ event: "database.checked-out-client-error" }));
    });
    // The dead client is still the caller's to destroy, and says it is dead.
    await expect(client.query("select 1")).rejects.toThrow();
    client.release(true);
    await connection.close();
  });

  it("hands an idle client's errors back to the pool, so they are logged once", async () => {
    const connection = createPostgresConnection(
      { schema: {}, connectionString: postgres.connectionString },
      { error: () => undefined },
    );
    const client = await connection.pool.connect();
    const [checkedOutListener] = client.listeners("error");
    expect(client.listenerCount("error")).toBe(1);
    client.release();
    // Released: the checked-out listener is gone and only pg-pool's own idle
    // listener — which reports to the pool's `error` log — is left.
    expect(client.listenerCount("error")).toBe(1);
    expect(client.listeners("error")).not.toContain(checkedOutListener);
    await connection.close();
  });
});
