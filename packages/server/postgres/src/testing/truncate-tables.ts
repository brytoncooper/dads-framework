import type { Pool } from "pg";

/**
 * Truncate-based reset between tests (docs/testing/seeders.md#speed) —
 * beats re-creating schemas or containers per test. Pass the domain tables
 * the suite touches; identity/session state usually rides along via CASCADE.
 */
export async function truncateTables(pool: Pool, tableNames: readonly string[]): Promise<void> {
  if (tableNames.length === 0) return;
  const quoted = tableNames.map((name) => `"${name}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

/**
 * Clears the audit trail between tests.
 *
 * Kept out of the list callers pass to `truncateTables` because almost no
 * suite should care: `audit_log` grows with every insert a seeder makes, and
 * leaving it alone costs nothing. A suite that ASSERTS on audit rows is the
 * exception, and it wants an empty table with `position` back at 1 so it can
 * read the rows it caused in the order it caused them.
 *
 * `TRUNCATE` fires no row triggers, so emptying the trail records nothing and
 * the immutability trigger — which guards UPDATE and DELETE — does not object.
 */
export async function truncateAuditLog(pool: Pool): Promise<void> {
  await truncateTables(pool, ["audit_log"]);
}

/**
 * Clears the request trail between tests.
 *
 * Separate from `truncateAuditLog` because the two tables answer different
 * questions and are kept on different terms: `request_log` is pruned on a
 * schedule and carries no trigger, `audit_log` is never pruned and carries
 * the immutability one. A suite asserting on request rows wants only its own,
 * and nothing else in the schema references them, so this is a plain truncate.
 */
export async function truncateRequestLog(pool: Pool): Promise<void> {
  await truncateTables(pool, ["request_log"]);
}
