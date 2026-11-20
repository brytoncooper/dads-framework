/**
 * What: on a real pool of 10 kept saturated by plain queries, with callers
 * always queued behind them, the partition lock is still taken and its
 * operation runs.
 * Why: lock holders are limited only by the connections OTHER LOCK HOLDERS
 * hold (`reserveLockConnection`). Ordinary load must queue a lock taker in
 * pg's own FIFO like any query, never turn an access write into
 * `AUTHORIZATION_PARTITION_BUSY`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";

import { PostgresOwnerLock } from "./owner-lock.js";

const POOL_SIZE = 10;
const PLAIN_WORKERS = 15;
const LOAD_MS = 2_500;

describe("PostgresOwnerLock under plain load (integration)", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startTestPostgres({ maxConnections: POOL_SIZE });
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it("is served while plain queries hold every connection and more wait", async () => {
    const pool = postgres.pool;
    const loadEndsAt = Date.now() + LOAD_MS;
    const plainLoad = Array.from({ length: PLAIN_WORKERS }, async () => {
      while (Date.now() < loadEndsAt) {
        await pool.query("SELECT pg_sleep(0.05)");
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sawCallersWaiting = pool.waitingCount > 0;

    const lock = new PostgresOwnerLock(pool);
    const servedAt = await lock.run("organization:under-load", () =>
      Promise.resolve(Date.now()),
    );

    expect(sawCallersWaiting).toBe(true);
    expect(servedAt).toBeLessThan(loadEndsAt);
    await Promise.all(plainLoad);
  });
});
