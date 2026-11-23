import { and, eq, gt, isNull, or } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";

import { authorizationOutbox } from "./access-changes.tables.js";

/**
 * Gives every fact that has not reached the graph a fresh attempt budget:
 * a FAILED fact goes back to PENDING, and a waiting PENDING fact's spent
 * attempts are forgiven. A fact a worker holds right now is left alone. Its
 * last error stays for the record.
 *
 * For an outbox with no human watching its failures (a remote instance’s
 * graph), where FAILED must mean "not yet", never "never", and an outage of
 * the graph must not spend a fact's attempts: the caller runs it after a
 * drain the graph took cleanly, and after failures it has shown were the
 * graph being unreachable. A waiting fact is never stale against a later
 * change to its tuple, because a producer that replaces opposite facts
 * supersedes PENDING and FAILED ones alike. Answers how many facts it reset.
 */
export async function requeueFailedAccessChanges(db: Pick<DrizzleHandle, "update">): Promise<number> {
  const reset = await db
    .update(authorizationOutbox)
    .set({ status: "PENDING", attempts: 0 })
    .where(
      and(
        isNull(authorizationOutbox.lockedBy),
        or(
          eq(authorizationOutbox.status, "FAILED"),
          and(eq(authorizationOutbox.status, "PENDING"), gt(authorizationOutbox.attempts, 0)),
        ),
      ),
    )
    .returning({ id: authorizationOutbox.id });
  return reset.length;
}
