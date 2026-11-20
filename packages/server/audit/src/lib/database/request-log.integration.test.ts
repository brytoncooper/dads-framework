/**
 * WHAT: `request_log` accepts a plain insert from application code (no
 * trigger fills it in), the row reads back by `request_id`, an unknown
 * `decision` is refused by the check constraint, and — the point of the
 * allowlist entry — writing to `request_log` produces no `audit_log` row.
 *
 * WHY against a real database: the check constraint and the absence of an
 * `audit_record` trigger are both facts about the installed schema, not
 * something a fake table could get wrong in the same way a real one can.
 * `truncateAuditLog` is imported from the postgres kit's testing barrel
 * (rather than reached for a raw `TRUNCATE`) so the one emptier the retention
 * suites also use is the one proven here.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
  truncateAuditLog,
  truncateTables,
} from "@dads-framework/postgres/testing";

import { makeRequestLog } from "../../testing/request-log.factory.js";
import { requestLog } from "./generated-tables/request-log.tables.js";

describe("request_log", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  afterEach(async () => {
    await truncateTables(postgres.pool, ["request_log"]);
    await truncateAuditLog(postgres.pool);
  });

  it("accepts an insert made outside any audit actor context and reads it back by request_id", async () => {
    const row = makeRequestLog();

    await db.insert(requestLog).values(row);

    const [found] = await db
      .select()
      .from(requestLog)
      .where(eq(requestLog.requestId, row.requestId));

    expect(found).toMatchObject({
      requestId: row.requestId,
      method: row.method,
      path: row.path,
      status: row.status,
      durationMs: row.durationMs,
      decision: row.decision,
    });
  });

  it("writes no audit_log row — request_log is allowlisted, not audited", async () => {
    await db.insert(requestLog).values(makeRequestLog());

    const audited = await postgres.pool.query(
      `SELECT 1 FROM audit_log WHERE table_name = 'request_log'`,
    );

    expect(audited.rows).toHaveLength(0);
  });

  it("refuses a decision the check constraint does not list", async () => {
    const refused = await db
      .insert(requestLog)
      .values(makeRequestLog({ decision: "maybe-later" }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refused).toBeDefined();
    expect(causeChain(refused)).toMatch(/request_log_decision_check/);
  });
});

/**
 * Drizzle reports a driver failure as `Failed query: …` and hangs the pg
 * error off `cause`, so the check constraint's own name is one link down the
 * chain (same shape proven in attributed-pool.integration.test.ts).
 */
function causeChain(error: unknown): string {
  const messages: string[] = [];
  let link: unknown = error;
  while (link instanceof Error) {
    messages.push(link.message);
    link = link.cause;
  }
  return messages.join(" | ");
}
