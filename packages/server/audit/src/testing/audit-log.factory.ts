import { deterministicUuid } from "@dads-framework/postgres/testing/deterministic-uuid";
import type { auditLog } from "../lib/database/generated-tables/audit-log.tables.js";

type AuditLogInsert = typeof auditLog.$inferInsert;

let auditLogCounter = 0;

/**
 * Every field valid by default, deterministic ids, overrides spread last
 * (docs/testing/seeders.md).
 *
 * The trigger is the only thing that writes `audit_log` in a running system,
 * so this factory exists to build the row a test expects rather than a row a
 * test inserts. `position`, `transactionId`, and `recordedAt` are absent
 * because the database mints all three.
 */
export function makeAuditLog(overrides: Partial<AuditLogInsert> = {}): AuditLogInsert {
  auditLogCounter += 1;
  const rowId = deterministicUuid("audit-log-row", auditLogCounter);
  return {
    actorKind: "system",
    actorId: "test",
    requestId: deterministicUuid("audit-log-request", auditLogCounter),
    reason: null,
    ownerPartitionId: null,
    tableName: "organizations",
    rowKey: { id: rowId },
    operation: "insert",
    changedColumns: null,
    rowBefore: null,
    rowAfter: { id: rowId, name: `audit subject ${String(auditLogCounter)}` },
    ...overrides,
  };
}
