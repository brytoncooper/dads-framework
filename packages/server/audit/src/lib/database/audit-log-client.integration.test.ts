import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { serializeAuditActor } from "@dads-framework/core/audit-actor";
import {
  startTestPostgres,
  truncateTables,
  type TestPostgres,
} from "@dads-framework/postgres/testing";

import { attachAuditTrigger } from "./attach-audit-trigger.js";
import { DrizzleAuditLogReader } from "./readers/drizzle-audit-log-reader.js";

const CLIENT_TABLE = "audit_client_fixture_rows";

type ClientColumns = {
  client_id: string | null;
  client_name: string | null;
};

/**
 * `20261027005034_audit_log_client`: a write made through an OAuth client
 * (an MCP client acting for a person) names that client on every row, and
 * every other write leaves both columns null.
 */
describe("audit_record client columns", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    const statements: string[] = [
      `CREATE TABLE IF NOT EXISTS ${CLIENT_TABLE} (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         label text
       )`,
    ];
    attachAuditTrigger(
      { sql: (statement: string) => statements.push(statement) },
      CLIENT_TABLE,
      { keyColumns: ["id"] },
    );
    for (const statement of statements) {
      await postgres.pool.query(statement);
    }
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await truncateTables(postgres.pool, ["audit_log", CLIENT_TABLE]);
  });

  /** One insert on its own client, attributed to the stamped actor. */
  async function insertAs(actorSetting: string): Promise<ClientColumns> {
    const client = await postgres.pool.connect();
    try {
      await client.query(`SELECT set_config('dads.audit_actor', $1, false)`, [
        actorSetting,
      ]);
      await client.query(`INSERT INTO ${CLIENT_TABLE} (label) VALUES ('row')`);
    } finally {
      client.release();
    }
    const recorded = await postgres.pool.query<ClientColumns>(
      `SELECT client_id, client_name FROM audit_log
        WHERE table_name = $1 ORDER BY position DESC LIMIT 1`,
      [CLIENT_TABLE],
    );
    const row = recorded.rows[0];
    if (row === undefined) throw new Error("the trigger wrote no row");
    return row;
  }

  it("records the OAuth client a person acted through", async () => {
    const columns = await insertAs(
      serializeAuditActor({
        kind: "user",
        id: "alice",
        requestId: "client-test",
        clientId: "client-claude",
        clientName: "Claude",
      }),
    );

    expect(columns).toEqual({
      client_id: "client-claude",
      client_name: "Claude",
    });
  });

  it("leaves both columns null for a write with no client", async () => {
    const columns = await insertAs(
      serializeAuditActor({ kind: "user", id: "alice", requestId: "web" }),
    );

    expect(columns).toEqual({ client_id: null, client_name: null });
  });

  it("reads the client back on the row", async () => {
    await insertAs(
      serializeAuditActor({
        kind: "user",
        id: "alice",
        requestId: "client-read",
        clientId: "client-chatgpt",
        clientName: "ChatGPT",
      }),
    );

    const rows = await new DrizzleAuditLogReader(
      drizzle(postgres.pool),
    ).listRows({ kind: "platform" }, {}, null, 10);

    expect(rows.map((row) => [row.clientId, row.clientName])).toEqual([
      ["client-chatgpt", "ChatGPT"],
    ]);
  });
});
