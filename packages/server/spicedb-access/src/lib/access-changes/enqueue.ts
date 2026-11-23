import { EnqueueAccessChanges as AccessChangesEnqueuer } from "@dads-framework/access/runtime";
import type { DrizzleHandle } from "@dads-framework/postgres";

export {
  accessChangesToWrite,
  OUTBOX_OPERATION_VALUES,
  outboxKeyForRelationship,
  type AccessChange,
  type OutboxOperation,
} from "@dads-framework/access/runtime";

export const OUTBOX_STATUS_VALUES = [
  "PENDING",
  "PROJECTED",
  "FAILED",
  "SUPERSEDED",
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUS_VALUES)[number];

/**
 * The caller's open transaction handle. The outbox uses insert and update.
 * Same-database authorization additionally requires execute on a real
 * transaction. Other writers and test doubles can still use the narrow port.
 */
export type OutboxTx = Pick<DrizzleHandle, "insert" | "update"> &
  Partial<Pick<DrizzleHandle, "execute">>;

export type EnqueueAccessChanges = AccessChangesEnqueuer<OutboxTx>;
export const EnqueueAccessChanges = AccessChangesEnqueuer<OutboxTx>;
