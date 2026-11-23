import { Pool } from "pg";
import {
  currentAuditActor,
  systemActor,
  type AuditActor,
} from "@dads-framework/core/audit-actor";
import { createAttributedPool } from "../lib/attributed-pool.js";
import { listenForCheckedOutClientErrors } from "../lib/checked-out-client-errors.js";

const TEARDOWN_PG_CODES = new Set(["57P01", "57P02", "57P03"]);

/**
 * Who a test is, when it has not said. The request id is the literal `test`
 * rather than a fresh uuid so a suite can filter `audit_log` down to "rows
 * nobody claimed" and get the same answer on every run.
 */
export const TEST_SYSTEM_ACTOR: AuditActor = systemActor("test", "test");

/**
 * The actor a test pool stamps: whatever context the test established, and
 * the system test actor otherwise.
 *
 * This fallback is what lets 33 seeders and every existing integration test
 * keep inserting raw rows unchanged after the `audit_record` trigger went
 * live — the trigger refuses an unattributed write, and a seeder
 * has no actor to give it. A test that DOES care runs inside
 * `runWithAuditActor` and gets its own actor on the same pool.
 */
export function testAuditActor(): AuditActor {
  return currentAuditActor() ?? TEST_SYSTEM_ACTOR;
}

export type CreateTestPoolOptions = {
  /**
   * Set false for the pool that has to prove the refusal itself — an
   * unattributed write reaching the trigger. Everything else wants the
   * default.
   */
  readonly attributed?: boolean;
  /**
   * The most connections this pool opens at once; pg's default (10) when
   * omitted. A suite that boots many pools against the one shared test
   * Postgres caps them so their sum stays under its `max_connections`.
   */
  readonly maxConnections?: number;
};

export function createTestPool(
  connectionString: string,
  options: CreateTestPoolOptions = {},
): Pool {
  const config = {
    connectionString,
    ...(options.maxConnections === undefined
      ? {}
      : { max: options.maxConnections }),
  };
  const pool =
    options.attributed === false
      ? new Pool(config)
      : createAttributedPool(config, testAuditActor);
  // Idle and checked-out clients alike: a test database stopped under a
  // client must fail that client's query, never the whole test worker.
  pool.on("error", ignoreTeardownError);
  listenForCheckedOutClientErrors(pool, ignoreTeardownError);
  return pool;
}

function ignoreTeardownError(err: Error): void {
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  if (TEARDOWN_PG_CODES.has(code)) {
    return;
  }
}
