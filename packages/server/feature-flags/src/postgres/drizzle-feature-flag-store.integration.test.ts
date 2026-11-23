/**
 * WHAT: the Postgres store keeps audience state, pilot tenants and history,
 * stores the wire revision as `row_version`, pages history newest first, and
 * rolls a whole batch back when any one revision is stale.
 *
 * WHY against a real database: the all-or-nothing batch is a transaction, the
 * first write races on a unique index, and the mode/timer rule is a CHECK
 * constraint. A fake would only prove the fake agrees with itself.
 *
 * The schema is this package's own migration, rendered by node-pg-migrate's
 * builder and run on an empty database.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { MigrationBuilder } from "node-pg-migrate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { UpdateFeatureFlags } from "../index.js";
import {
  FakeTenantDirectory,
  featureFlagDefinitionFactory,
  FixedClock,
  verifyFeatureFlagStoreConformance,
} from "../testing/index.js";
import { startUnmigratedTestPostgres, type TestPostgres, truncateTables } from "@dads-framework/postgres/testing";

import { DrizzleFeatureFlagStore } from "./drizzle-feature-flag-store.js";
import { up } from "./migrations/20261119180000_feature_flags.migration.js";

const FIRST = featureFlagDefinitionFactory({ slug: "orders.first" });
const SECOND = featureFlagDefinitionFactory({ slug: "orders.second" });
const DAY_ONE = new Date("2026-09-11T16:00:00.000Z");
const DAY_TWO = new Date("2026-09-12T16:00:00.000Z");

function migrationSql(): string {
  const builder = new MigrationBuilder(
    {
      query: () => Promise.reject(new Error("Schema assembly performs no I/O")),
      select: () => Promise.resolve([]),
    },
    undefined,
    false,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );
  up(builder);
  return builder.getSql();
}

describe("DrizzleFeatureFlagStore", () => {
  let postgres: TestPostgres;
  let store: DrizzleFeatureFlagStore;

  function updateAt(now: Date): UpdateFeatureFlags {
    return new UpdateFeatureFlags(
      [FIRST, SECOND],
      store,
      new FakeTenantDirectory().name("t-1", "Acme").name("t-2", "Globex"),
      new FixedClock(now),
    );
  }

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    await postgres.pool.query(migrationSql());
    store = new DrizzleFeatureFlagStore(drizzle(postgres.pool));
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  async function emptyTables(): Promise<void> {
    await truncateTables(postgres.pool, [
      "feature_flag_change_events",
      "feature_flag_tenant_targets",
      "feature_flag_states",
    ]);
  }

  beforeEach(emptyTables);

  it("keeps every FeatureFlagStore promise", async () => {
    await expect(
      verifyFeatureFlagStoreConformance(async () => {
        await emptyTables();
        return store;
      }),
    ).resolves.toBeUndefined();
  });

  it("persists an EVERYONE audience with its global activation time", async () => {
    const [written] = await updateAt(DAY_ONE).execute({
      actorId: "user-1",
      request: {
        changes: [{ slug: FIRST.slug, expectedRevision: 0, mode: "EVERYONE" }],
      },
    });
    expect(written?.globalEnabledAt).toBe(DAY_ONE.toISOString());
    await expect(store.listStates([FIRST.slug])).resolves.toEqual([written]);
  });

  it("stores the state's revision as row_version on a first write and a later one", async () => {
    const counters = async () =>
      (await postgres.pool.query<{ row_version: number }>("SELECT row_version FROM feature_flag_states")).rows;
    await updateAt(DAY_ONE).execute({
      actorId: "user-1",
      request: {
        changes: [{ slug: FIRST.slug, expectedRevision: 0, mode: "OFF" }],
      },
    });
    expect(await counters()).toEqual([{ row_version: 1 }]);
    await updateAt(DAY_TWO).execute({
      actorId: "user-1",
      request: {
        changes: [{ slug: FIRST.slug, expectedRevision: 1, mode: "EVERYONE" }],
      },
    });
    expect(await counters()).toEqual([{ row_version: 2 }]);
    await expect(store.listStates([FIRST.slug])).resolves.toMatchObject([{ revision: 2 }]);
  });

  it("retains SELECTED_TENANTS targets and pages history newest-first", async () => {
    await updateAt(DAY_ONE).execute({
      actorId: "user-1",
      request: {
        changes: [
          {
            slug: FIRST.slug,
            expectedRevision: 0,
            mode: "SELECTED_TENANTS",
            tenantIds: ["t-1", "t-2"],
          },
        ],
      },
    });
    await updateAt(DAY_TWO).execute({
      actorId: "user-2",
      request: {
        changes: [{ slug: FIRST.slug, expectedRevision: 1, mode: "OFF" }],
      },
    });
    const [stored] = await store.listStates([FIRST.slug]);
    expect(stored?.rememberedTenants).toEqual(
      expect.arrayContaining([
        { tenantId: "t-1", tenantName: "Acme", enabledAt: null },
        { tenantId: "t-2", tenantName: "Globex", enabledAt: null },
      ]),
    );
    const page = await store.listHistory({
      slug: FIRST.slug,
      page: 1,
      perPage: 1,
    });
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.revision)).toEqual([2]);
    const older = await store.listHistory({
      slug: FIRST.slug,
      page: 2,
      perPage: 1,
    });
    expect(older.rows.map((row) => row.revision)).toEqual([1]);
  });

  it("rolls back the whole batch when a later flag has a revision conflict", async () => {
    await updateAt(DAY_ONE).execute({
      actorId: "user-1",
      request: {
        changes: [{ slug: SECOND.slug, expectedRevision: 0, mode: "OFF" }],
      },
    });
    const result = await store.applyBatch({
      expectedRevisions: new Map([
        [FIRST.slug, 0],
        [SECOND.slug, 0],
      ]),
      nextStates: [
        {
          slug: FIRST.slug,
          audienceMode: "OFF",
          rememberedTenants: [],
          revision: 1,
          globalEnabledAt: null,
          updatedAt: DAY_TWO.toISOString(),
          updatedBy: "user-2",
        },
        {
          slug: SECOND.slug,
          audienceMode: "OFF",
          rememberedTenants: [],
          revision: 1,
          globalEnabledAt: null,
          updatedAt: DAY_TWO.toISOString(),
          updatedBy: "user-2",
        },
      ],
      history: [],
    });
    expect(result).toBe("revision-conflict");
    await expect(store.listStates([FIRST.slug])).resolves.toEqual([]);
    const history = await store.listHistory({
      slug: SECOND.slug,
      page: 1,
      perPage: 10,
    });
    expect(history.total).toBe(1);
  });

  it("records previous and next state, batch, actor, time and an optional note for each revision", async () => {
    const [next] = await updateAt(DAY_ONE).execute({
      actorId: "user-1",
      request: {
        changes: [
          {
            slug: FIRST.slug,
            expectedRevision: 0,
            mode: "EVERYONE",
            note: "launch",
          },
          { slug: SECOND.slug, expectedRevision: 0, mode: "OFF" },
        ],
      },
    });
    const first = await store.listHistory({
      slug: FIRST.slug,
      page: 1,
      perPage: 10,
    });
    const second = await store.listHistory({
      slug: SECOND.slug,
      page: 1,
      perPage: 10,
    });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      revision: 1,
      previousState: { revision: 0, audienceMode: "OFF" },
      nextState: next,
      note: "launch",
      changedAt: DAY_ONE.toISOString(),
      changedBy: "user-1",
    });
    expect(second.rows[0]).not.toHaveProperty("note");
    expect(second.rows[0]?.batchId).toBe(first.rows[0]?.batchId);
  });

  it("refuses EVERYONE without a global activation time at the database", async () => {
    await expect(
      postgres.pool.query(
        "INSERT INTO feature_flag_states (id, slug, audience_mode, updated_by) VALUES (gen_random_uuid(), 'orders.first', 'EVERYONE', 'user-1')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
