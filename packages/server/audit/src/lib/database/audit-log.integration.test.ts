/**
 * WHAT: the `audit_record` trigger records every insert, update, and delete on
 * an audited table, refuses a write that carries no actor,
 * and cannot itself be rewritten.
 *
 * WHY against a real database: every claim here is a property of PostgreSQL
 * DDL — a trigger's firing conditions, a `RAISE` inside plpgsql, a jsonb key
 * diff, the key columns resolved from a unique index. None of them exist in
 * TypeScript, so a fake would only prove that the fake agrees with itself.
 *
 * WHY raw SQL on kit-owned fixture tables: the actor is a session setting,
 * so the write and the `set_config` that attributes it must run on one
 * checked-out client. The tables are the kit's own (`testing/audited-fixture-
 * tables.ts`), put under audit by `attachAuditTrigger` as a real migration
 * does; writing a product's tables would tie the kit's results to that
 * product's migrations. That the install migration attached the tables that
 * already existed is proven against the application’s tables in
 * the application’s migration suite.
 *
 * The shared test pool stamps a fallback actor of its own, so every write
 * here sets the config explicitly on its own client: the contract under test
 * is the trigger's, and it must hold whatever the pool happens to do.
 */
import type { PostgresConnection } from "@dads-framework/postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres, truncateTables } from "@dads-framework/postgres/testing";

import { AUDITED_FIXTURE_TABLES, createAuditedFixtureTables } from "./testing/audited-fixture-tables.js";

const SYSTEM_ACTOR = JSON.stringify({
  kind: "system",
  id: "test",
  requestId: "r1",
});

const TOUCHED_TABLES = ["audit_log", ...AUDITED_FIXTURE_TABLES, "authorization_outbox"];

type AuditRow = {
  table_name: string;
  operation: string;
  actor_kind: string;
  actor_id: string;
  request_id: string;
  reason: string | null;
  row_key: Record<string, unknown>;
  changed_columns: string[] | null;
  row_before: Record<string, unknown> | null;
  row_after: Record<string, unknown> | null;
  owner_partition_id: string | null;
};

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await createAuditedFixtureTables(postgres.pool);
}, 120_000);

afterAll(async () => {
  await postgres.stop();
});

afterEach(async () => {
  await truncateTables(postgres.pool, TOUCHED_TABLES);
});

type AuditFixtureClient = Pick<PostgresConnection["pool"], "query">;

/** Run statements on one client, with the audit actor set on that client. */
async function attributed<T>(actor: string, run: (client: AuditFixtureClient) => Promise<T>): Promise<T> {
  const client = await postgres.pool.connect();
  try {
    await client.query(`SELECT set_config('dads.audit_actor', $1, false)`, [actor]);
    return await run(client);
  } finally {
    client.release();
  }
}

async function auditRowsFor(tableName: string): Promise<AuditRow[]> {
  const result = await postgres.pool.query<AuditRow>(
    `SELECT table_name, operation, actor_kind, actor_id, request_id, reason, row_key,
            changed_columns, row_before, row_after, owner_partition_id
       FROM audit_log
      WHERE table_name = $1
      ORDER BY position`,
    [tableName],
  );
  return result.rows;
}

async function insertParty(client: AuditFixtureClient, slug: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO audit_fixture_parties (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Audited ${slug}`, slug],
  );
  const created = result.rows[0];
  if (created === undefined) {
    throw new Error("insert returned no row");
  }
  return created.id;
}

describe("the audit_record trigger", () => {
  it("records an insert with its actor, key, and new row", async () => {
    const id = await attributed(SYSTEM_ACTOR, (client) => insertParty(client, "audited-insert"));

    const rows = await auditRowsFor("audit_fixture_parties");

    expect(rows).toHaveLength(1);
    const [recorded] = rows;
    expect(recorded?.operation).toBe("insert");
    expect(recorded?.actor_kind).toBe("system");
    expect(recorded?.actor_id).toBe("test");
    expect(recorded?.request_id).toBe("r1");
    expect(recorded?.row_key).toEqual({ id });
    expect(recorded?.row_after).not.toBeNull();
    expect(recorded?.row_after?.["slug"]).toBe("audited-insert");
    expect(recorded?.row_before).toBeNull();
    expect(recorded?.changed_columns).toBeNull();
  });

  it("names exactly the columns an update touched", async () => {
    await attributed(SYSTEM_ACTOR, async (client) => {
      await insertParty(client, "audited-update");
      await client.query(`UPDATE audit_fixture_parties SET name = $1, locale = $2 WHERE slug = $3`, [
        "Renamed",
        "es-MX",
        "audited-update",
      ]);
    });

    const rows = await auditRowsFor("audit_fixture_parties");

    expect(rows.map((row) => row.operation)).toEqual(["insert", "update"]);
    const updated = rows[1];
    // Exactly the two columns the statement set, and no others.
    expect(updated?.changed_columns).toEqual(["locale", "name"]);
    expect(updated?.row_before?.["name"]).toBe("Audited audited-update");
    expect(updated?.row_after?.["name"]).toBe("Renamed");
  });

  it("keeps the whole row a delete removed", async () => {
    await attributed(SYSTEM_ACTOR, async (client) => {
      await insertParty(client, "audited-delete");
      await client.query(`DELETE FROM audit_fixture_parties WHERE slug = $1`, ["audited-delete"]);
    });

    const rows = await auditRowsFor("audit_fixture_parties");

    expect(rows.map((row) => row.operation)).toEqual(["insert", "delete"]);
    const deleted = rows[1];
    expect(deleted?.row_before?.["slug"]).toBe("audited-delete");
    expect(deleted?.row_after).toBeNull();
    expect(deleted?.changed_columns).toBeNull();
  });

  it("refuses a write without an actor and leaves no audit row", async () => {
    await expect(attributed("", (client) => insertParty(client, "missing-actor"))).rejects.toMatchObject({
      code: "42501",
    });
    expect(await auditRowsFor("audit_fixture_parties")).toEqual([]);
  });

  it("records a keyless table's row_key from the key columns it was attached with, and its owner", async () => {
    const deviceId = "11111111-1111-4111-8111-111111111111";
    const partitionId = "22222222-2222-4222-8222-222222222222";

    await attributed(SYSTEM_ACTOR, (client) =>
      client.query(
        `INSERT INTO audit_fixture_reports (device_id, application, partition_id)
         VALUES ($1, 'example-app', $2)`,
        [deviceId, partitionId],
      ),
    );

    const rows = await auditRowsFor("audit_fixture_reports");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.row_key).toEqual({
      device_id: deviceId,
      application: "example-app",
    });
    expect(rows[0]?.owner_partition_id).toBe(partitionId);
  });

  it("leaves the allowlisted tables alone", async () => {
    await attributed(SYSTEM_ACTOR, (client) =>
      client.query(
        `INSERT INTO authorization_outbox (
           idempotency_key, operation, resource_type, resource_id, relation,
           subject_type, subject_id, status, enqueued_at
         ) VALUES ($1, 'WRITE', 'fixtures/party', $2, 'admin',
                   'user', $3, 'PENDING', now())`,
        ["audit-allowlist-1", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"],
      ),
    );

    expect(await auditRowsFor("authorization_outbox")).toHaveLength(0);
  });
});

describe("audit_log itself", () => {
  it("refuses updates and deletes of its own rows", async () => {
    await attributed(SYSTEM_ACTOR, (client) => insertParty(client, "audited-immutable"));
    expect(await auditRowsFor("audit_fixture_parties")).toHaveLength(1);

    await expect(postgres.pool.query(`UPDATE audit_log SET reason = 'rewritten'`)).rejects.toThrow(/immutable/u);
    await expect(postgres.pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/immutable/u);

    expect(await auditRowsFor("audit_fixture_parties")).toHaveLength(1);
  });
});
