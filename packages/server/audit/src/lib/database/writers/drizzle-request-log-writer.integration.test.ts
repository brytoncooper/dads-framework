/**
 * WHAT: `DrizzleRequestLogWriter` deletes only the `request_log` rows
 * recorded strictly before its cutoff, keeps newer rows, returns exactly how
 * many rows it removed, and the delete itself produces no `audit_log` row —
 * the point of `request_log`'s allowlist entry.
 *
 * WHY against a real database: the returned count depends on the driver's
 * `DELETE ... RETURNING` behavior, and "produces no audit_log row" is a fact
 * about the installed trigger, not something a fake table could get wrong in
 * the same way a real one can.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  startTestPostgres,
  truncateAuditLog,
  truncateTables,
  type TestPostgres,
} from "@dads-framework/postgres/testing";
import { makeRequestLog } from "../../../testing/request-log.factory.js";
import { requestLog } from "../generated-tables/request-log.tables.js";
import { DrizzleRequestLogWriter } from "./drizzle-request-log-writer.js";

describe("DrizzleRequestLogWriter", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let writer: DrizzleRequestLogWriter;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    writer = new DrizzleRequestLogWriter(db);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await truncateTables(postgres.pool, ["request_log"]);
    await truncateAuditLog(postgres.pool);
  });

  it("deletes rows recorded before the cutoff, keeps the cutoff row and newer rows, and counts correctly", async () => {
    const cutoff = new Date("2026-01-01T00:00:00.000Z");
    const old = makeRequestLog({
      recordedAt: new Date("2025-12-31T23:59:59.000Z"),
    });
    const atCutoff = makeRequestLog({ recordedAt: cutoff });
    const recent = makeRequestLog({
      recordedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    await db.insert(requestLog).values([old, atCutoff, recent]);

    const deletedCount = await writer.deleteRecordedBefore(cutoff);

    expect(deletedCount).toBe(1);
    const remaining = await db
      .select({ requestId: requestLog.requestId })
      .from(requestLog);
    expect(remaining.map((row) => row.requestId).sort()).toEqual(
      [atCutoff.requestId, recent.requestId].sort(),
    );
  });

  it("returns 0 and deletes nothing when every row is newer than the cutoff", async () => {
    await db
      .insert(requestLog)
      .values(makeRequestLog({ recordedAt: new Date() }));

    const deletedCount = await writer.deleteRecordedBefore(
      new Date("2000-01-01T00:00:00.000Z"),
    );

    expect(deletedCount).toBe(0);
    const remaining = await db.select().from(requestLog);
    expect(remaining).toHaveLength(1);
  });

  it("produces no audit_log row — request_log is allowlisted, not audited", async () => {
    await db
      .insert(requestLog)
      .values(
        makeRequestLog({ recordedAt: new Date("2025-01-01T00:00:00.000Z") }),
      );

    await writer.deleteRecordedBefore(new Date());

    const audited = await postgres.pool.query(
      `SELECT 1 FROM audit_log WHERE table_name = 'request_log'`,
    );
    expect(audited.rows).toHaveLength(0);
  });
});
