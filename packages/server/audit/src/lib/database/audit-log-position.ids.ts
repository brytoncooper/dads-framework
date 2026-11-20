/**
 * The row's rank in insertion order — an identity sequence, never a value
 * application code constructs.
 */
export type AuditLogPosition = number & { readonly brand: "AuditLogPosition" };

/**
 * A position read back from a cursor or an entry id a client sent: a positive
 * safe integer, or null. It names a row only if one exists there.
 */
export function parseAuditLogPosition(value: number): AuditLogPosition | null {
  return isAuditLogPosition(value) ? value : null;
}

function isAuditLogPosition(value: number): value is AuditLogPosition {
  return Number.isSafeInteger(value) && value > 0;
}
