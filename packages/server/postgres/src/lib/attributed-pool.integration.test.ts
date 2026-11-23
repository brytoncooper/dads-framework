import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentAuditActor, runWithAuditActor, type AuditActor } from "@dads-framework/core/audit-actor";
import { startTestPostgres, startUnattributedTestPostgres, type TestPostgres } from "../testing/start-test-postgres.js";
import { truncateAuditLog, truncateTables } from "../testing/truncate-tables.js";
import { createAttributedPool } from "./attributed-pool.js";

/**
 * What: proves the attributed pool against the real `audit_record` trigger —
 * both of Drizzle's client paths land attributed, the trigger refuses
 * unstamped writes, and no checkout inherits the previous one's actor.
 *
 * Why here rather than in a domain suite: this is the seam where ADR-0112's
 * mandatory attribution either holds or silently does not. The unit tests
 * beside it prove the checkout logic with a fake client; only a real Postgres
 * with the trigger installed can prove that `set_config` at session level,
 * once per checkout, is what the trigger actually needs.
 */

/**
 * A kit-owned audited table, created in each test database the way a real
 * table's migration puts itself under audit. The suite formerly wrote the application's
 * `organizations`, which tied the kit's results to one product's migrations.
 * The postgres kit cannot import the audit kit's `attachAuditTrigger` (the
 * audit kit imports this one), so the trigger statement is spelled out here;
 * the `audit_record` function itself comes from the audit kit's migrations,
 * which the kit's integration inputs name.
 */
const FIXTURE_TABLE = "attribution_fixture_parties";

const attributionFixtureParties = pgTable(FIXTURE_TABLE, {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
});

async function createAttributionFixtureTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${FIXTURE_TABLE} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       name text NOT NULL,
       slug text NOT NULL
     )`,
  );
  await pool.query(
    `CREATE OR REPLACE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON ${FIXTURE_TABLE} FOR EACH ROW EXECUTE FUNCTION audit_record('id', '')`,
  );
}

type AuditRow = {
  actor_kind: string;
  actor_id: string;
  request_id: string;
  operation: string;
  table_name: string;
  row_key: { id: string };
};

const USER_ACTOR: AuditActor = {
  kind: "user",
  id: "user-1",
  requestId: "01990000-0000-7000-8000-00000000000a",
};
const OTHER_USER_ACTOR: AuditActor = {
  kind: "user",
  id: "user-2",
  requestId: "01990000-0000-7000-8000-00000000000b",
};

describe("attributed pool (integration)", () => {
  let postgres: TestPostgres;
  let unattributed: TestPostgres;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    unattributed = await startUnattributedTestPostgres();
    db = drizzle(postgres.pool);
    await createAttributionFixtureTable(postgres.pool);
    await createAttributionFixtureTable(unattributed.pool);
  }, 180_000);

  afterAll(async () => {
    await postgres.stop();
    await unattributed.stop();
  });

  beforeEach(async () => {
    await truncateTables(postgres.pool, [FIXTURE_TABLE]);
    await truncateAuditLog(postgres.pool);
    await truncateTables(unattributed.pool, [FIXTURE_TABLE]);
    await truncateAuditLog(unattributed.pool);
  });

  it("attributes a plain insert to the actor of the task that made it", async () => {
    const created = await runWithAuditActor(USER_ACTOR, () =>
      db
        .insert(attributionFixtureParties)
        .values({ name: "Acme Feed", slug: "acme-feed" })
        .returning({ id: attributionFixtureParties.id }),
    );

    expect(await fixtureAuditRows(postgres)).toEqual([
      expect.objectContaining({
        actor_kind: "user",
        actor_id: "user-1",
        request_id: USER_ACTOR.requestId,
        operation: "insert",
        table_name: FIXTURE_TABLE,
        row_key: { id: created[0]?.id },
      }),
    ]);
  });

  // Drizzle runs a transaction by checking a client out of the pool and
  // sending `begin` down it — a different code path from the single-statement
  // one above, and the reason `connect` is stamped rather than `query`.
  it("attributes a transaction, which Drizzle runs on one checked-out client", async () => {
    await runWithAuditActor(USER_ACTOR, () =>
      db.transaction(async (tx) => {
        await tx.insert(attributionFixtureParties).values({ name: "Bulk Grain", slug: "bulk-grain" });
      }),
    );

    expect(await fixtureAuditRows(postgres)).toEqual([
      expect.objectContaining({
        actor_kind: "user",
        actor_id: "user-1",
        request_id: USER_ACTOR.requestId,
        operation: "insert",
      }),
    ]);
  });

  it("refuses an unstamped write without leaving a business or audit row", async () => {
    const unstamped = drizzle(unattributed.pool);

    await expect(
      unstamped.insert(attributionFixtureParties).values({ name: "Nobody", slug: "nobody" }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });

    expect(await unstamped.select().from(attributionFixtureParties)).toEqual([]);
    expect(await fixtureAuditRows(unattributed)).toEqual([]);
  });

  it("still reads on an unattributed connection — the trigger guards writes, not queries", async () => {
    const unstamped = drizzle(unattributed.pool);

    await expect(
      unstamped.select({ id: attributionFixtureParties.id }).from(attributionFixtureParties),
    ).resolves.toEqual([]);
  });

  // The setting is session level, so it outlives the statement that set it and
  // survives the client's release back into the pool. That is exactly why the
  // NEXT checkout has to overwrite it: `max: 1` forces both contexts onto the
  // same physical backend, and the pid assertion keeps the proof from passing
  // vacuously on two different connections.
  it("re-stamps each checkout, so the second context never inherits the first actor", async () => {
    const singleConnection = createAttributedPool(
      { connectionString: postgres.connectionString, max: 1 },
      currentAuditActor,
    );
    const single = drizzle(singleConnection);
    try {
      const firstBackend = await runWithAuditActor(USER_ACTOR, async () => {
        await single.insert(attributionFixtureParties).values({ name: "First", slug: "first" });
        return backendPid(singleConnection);
      });
      const secondBackend = await runWithAuditActor(OTHER_USER_ACTOR, async () => {
        await single.insert(attributionFixtureParties).values({ name: "Second", slug: "second" });
        return backendPid(singleConnection);
      });

      expect(secondBackend).toBe(firstBackend);
      const audited = await fixtureAuditRows(postgres);
      expect(audited.map((row) => row.actor_id)).toEqual(["user-1", "user-2"]);
      expect(audited.map((row) => row.request_id)).toEqual([USER_ACTOR.requestId, OTHER_USER_ACTOR.requestId]);
    } finally {
      await singleConnection.end();
    }
  });

  // What keeps 33 seeders and every pre-existing integration test green: they
  // insert raw, outside any context, and the test pool answers for them.
  it("falls back to the system test actor outside any context", async () => {
    await db.insert(attributionFixtureParties).values({ name: "Seeded", slug: "seeded" });

    expect(await fixtureAuditRows(postgres)).toEqual([
      expect.objectContaining({
        actor_kind: "system",
        actor_id: "test",
        request_id: "test",
      }),
    ]);
  });
});

async function fixtureAuditRows(postgres: TestPostgres): Promise<AuditRow[]> {
  const audited = await postgres.pool.query<AuditRow>(
    `SELECT actor_kind, actor_id, request_id, operation, table_name, row_key
       FROM audit_log
      WHERE table_name = $1
      ORDER BY position`,
    [FIXTURE_TABLE],
  );
  return audited.rows;
}

async function backendPid(pool: Pool): Promise<number> {
  const answered = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return answered.rows[0]?.pid ?? -1;
}
