import { type AuditLogPosition, parseAuditLogPosition } from "../lib/database/audit-log-position.ids.js";
import type { AuditLogRecord } from "../lib/database/readers/audit-log-reader.interface.js";

let auditLogRecordCounter = 0;

/**
 * One row as `AuditLogReader` returns it, for unit tests of code that reads
 * the trail. Every field valid by default, deterministic values, overrides
 * spread last (docs/testing/seeders.md). Unlike `makeAuditLog`, this is the
 * read shape: it carries the position and the keyset cursor the database
 * would have minted.
 */
export function makeAuditLogRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  auditLogRecordCounter += 1;
  const positioned = overrides.position ?? standInPosition(1_000_000 - auditLogRecordCounter);
  const recordedAt = overrides.recordedAt ?? new Date("2026-10-22T14:00:00.000Z");
  return {
    position: positioned,
    scopeValues: null,
    recordedAt,
    actorKind: "user",
    actorId: "user-1",
    clientId: null,
    clientName: null,
    requestId: `request-${String(auditLogRecordCounter)}`,
    reason: null,
    userId: "user-1",
    tableName: "audit_fixture_parties",
    rowKey: { id: `row-${String(auditLogRecordCounter)}` },
    operation: "update",
    changedColumns: ["name"],
    rowBefore: { name: "Before" },
    rowAfter: { name: "After" },
    cursor: {
      recordedAt: `${recordedAt.toISOString().slice(0, -1)}000Z`,
      position: positioned,
    },
    ...overrides,
  };
}

/** Positions are minted by the database; a test stands one in. */
export function standInPosition(position: number): AuditLogPosition {
  const parsed = parseAuditLogPosition(position);
  if (parsed === null) {
    throw new Error(`Not an audit log position: ${String(position)}`);
  }
  return parsed;
}
