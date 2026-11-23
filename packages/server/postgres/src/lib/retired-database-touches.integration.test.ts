import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readRetiredDatabaseTouches,
  recordRetiredDatabaseTouches,
} from "../testing/global-setup/retired-database-touches.js";
import { startUnmigratedTestPostgres, type TestPostgres } from "../testing/start-test-postgres.js";

/**
 * The ledger that keeps the schema-keyed check honest under
 * `TEST_POSTGRES_STORAGE=ram`, exercised directly so it is proven whatever
 * storage this run uses: a dropped database's touched tables, and a row for a
 * database that touched nothing, read back by its run prefix.
 */
describe("retired database touches ledger", () => {
  let server: TestPostgres | undefined;
  let admin: Pool | undefined;
  const prefix = `ledger${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const busyName = `test_${prefix}_m_busy`;
  const idleName = `test_${prefix}_u_idle`;

  beforeAll(async () => {
    server = await startUnmigratedTestPostgres({ attributed: false });
    admin = new Pool({
      connectionString: withDatabase(server.connectionString, "postgres"),
      max: 1,
    });
  }, 180_000);

  // Retire the probes the way stop() does on disk: shut, not dropped. A DROP
  // on a disk-backed shared server forces a checkpoint that can outlast the
  // hook timeout on a loaded runner (start-test-postgres.ts).
  afterAll(async () => {
    const made = await admin?.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname = ANY($1)", [
      [busyName, idleName],
    ]);
    for (const { datname } of made?.rows ?? []) {
      await admin?.query(`ALTER DATABASE "${datname}" ALLOW_CONNECTIONS false`);
    }
    await admin?.end();
    await server?.stop();
  });

  it("records the tables a database touched, and a database that touched nothing, then reads them back", async () => {
    if (server === undefined || admin === undefined) {
      throw new Error("Postgres did not start");
    }
    await admin.query(`CREATE DATABASE "${busyName}"`);
    await admin.query(`CREATE DATABASE "${idleName}"`);
    const busyUrl = withDatabase(server.connectionString, busyName);
    const idleUrl = withDatabase(server.connectionString, idleName);

    // A Client, not a Pool: its end() resolves only once the backend has
    // closed the socket, by which point it has published its table counters.
    const busy = new Client({ connectionString: busyUrl });
    await busy.connect();
    try {
      await busy.query("CREATE TABLE ledger_probe (value integer)");
      await busy.query("INSERT INTO ledger_probe VALUES (1)");
    } finally {
      await busy.end();
    }

    await recordThroughReader(admin, busyUrl, busyName);
    await recordThroughReader(admin, idleUrl, idleName);

    const rows = await readRetiredDatabaseTouches(admin, prefix);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          databaseName: busyName,
          schemaName: "public",
          tableName: "ledger_probe",
        },
        { databaseName: busyName, schemaName: null, tableName: null },
        { databaseName: idleName, schemaName: null, tableName: null },
      ]),
    );
    expect(await readRetiredDatabaseTouches(admin, `other${prefix}`)).toEqual([]);
  });
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The ledger reads through a connection its caller owns, as stop() does. */
async function recordThroughReader(admin: Pool, databaseUrl: string, name: string): Promise<void> {
  const reader = new Client({ connectionString: databaseUrl });
  await reader.connect();
  try {
    await recordRetiredDatabaseTouches(admin, reader, name);
  } finally {
    await reader.end();
  }
}
