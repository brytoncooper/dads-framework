/**
 * What: databaseService, postgresPoolService, and providePostgresDatabase.
 * Why: domain plugins declare narrow database capability requirements and the
 * host closes the connection pool automatically when the plugin scope stops.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { composeApp, createTestHost, definePlugin, overrideService } from "@dads-framework/core/plugin";

import type { DrizzleHandle } from "../drizzle.js";
import { databaseService, postgresPoolService, providePostgresDatabase, type PgPool } from "./database-service.js";

describe("databaseService and providePostgresDatabase", () => {
  it("exports typed capability tokens for Drizzle and PgPool", () => {
    expect(databaseService.kind).toBe("service");
    expect(databaseService.name).toBe("database");
    expect(databaseService.dependencyName).toBe("service:database");

    expect(postgresPoolService.kind).toBe("service");
    expect(postgresPoolService.name).toBe("postgres-pool");
    expect(postgresPoolService.dependencyName).toBe("service:postgres-pool");
  });

  it("opens a managed connection, exposes databaseService, and closes the pool on stop", async () => {
    const provider = providePostgresDatabase({
      connectionString: "postgres://user:pass@127.0.0.1:1/unused",
      log: { error: vi.fn() },
    });
    expect(provider.name).toBe("postgres-database");

    const customProvider = providePostgresDatabase({
      name: "read-replica",
      connectionString: "postgres://user:pass@127.0.0.1:1/unused",
      log: { error: vi.fn() },
    });
    expect(customProvider.name).toBe("read-replica");

    const consumer = definePlugin({
      name: "records-repo",
      requires: [databaseService],
      setup: ({ use }) => {
        const db = use(databaseService);
        expectTypeOf(db).toEqualTypeOf<DrizzleHandle>();
        return { provides: { db } };
      },
    });

    const running = await composeApp([consumer, provider]).start();
    const directDb = running.read(provider);
    expectTypeOf(directDb.$client).toEqualTypeOf<PgPool>();
    expect(running.read(databaseService)).toBe(directDb);
    expect(running.read(consumer).db).toBe(directDb);

    const endSpy = vi.spyOn(directDb.$client, "end");
    await running.stop();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it("supports swapping databaseService and postgresPoolService with overrideService in tests", async () => {
    const consumer = definePlugin({
      name: "pool-consumer",
      requires: [postgresPoolService],
      setup: ({ use }) => {
        const pool = use(postgresPoolService);
        expectTypeOf(pool).toEqualTypeOf<PgPool>();
        return { provides: { totalCount: pool.totalCount } };
      },
    });

    const poolProvider = providePostgresDatabase({
      connectionString: "postgres://user:pass@127.0.0.1:1/unused",
      log: { error: vi.fn() },
    });
    const fakePoolRun = await composeApp([poolProvider]).start();
    const pool = fakePoolRun.read(poolProvider).$client;
    try {
      const host = await createTestHost({
        plugins: [consumer],
        overrides: [overrideService(postgresPoolService, pool)],
      });
      try {
        expect(host.read(consumer).totalCount).toBe(0);
        expect(host.read(postgresPoolService)).toBe(pool);
      } finally {
        await host.stop();
      }
    } finally {
      await fakePoolRun.stop();
    }
  });
});
