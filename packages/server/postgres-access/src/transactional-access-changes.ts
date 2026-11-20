import {
  ApplyAccessChangesAfterCommit,
  EnqueueAccessChanges,
  type AccessChange,
} from "@dads-framework/access/runtime";
import type { DrizzleHandle } from "@dads-framework/postgres";
import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

import type { PostgresAuthorization } from "./postgres-authorization.js";

type OutboxTx = Pick<DrizzleHandle, "insert" | "update"> &
  Partial<Pick<DrizzleHandle, "execute">>;

/** Binds the existing relationship-fact port to the same transaction as the business write. */
export class TransactionalAccessChanges extends EnqueueAccessChanges<OutboxTx> {
  constructor(
    private readonly authorization: PostgresAuthorization,
    private readonly database: Pick<DrizzleHandle, "transaction">,
  ) {
    super();
  }

  override enqueue(
    entries: readonly AccessChange[],
    tx: OutboxTx,
  ): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    if (tx.execute === undefined || !is(tx, PgTransaction)) {
      throw new Error(
        "Postgres access changes require the caller's Drizzle transaction",
      );
    }
    return this.authorization.inDrizzleTransaction(tx).applyChanges(entries);
  }

  override enqueueReplacingOpposite(
    entries: readonly AccessChange[],
    tx: OutboxTx,
  ): Promise<void> {
    // There are no queued facts to supersede. Apply this change in the caller's transaction.
    return this.enqueue(entries, tx);
  }

  override append(entries: readonly AccessChange[]): Promise<void> {
    return this.database.transaction((tx) => this.enqueue(entries, tx));
  }
}

/** The row and its access facts are already committed when this port runs. */
export class AlreadyAppliedAccessChanges extends ApplyAccessChangesAfterCommit {
  override dispatch(): Promise<void> {
    return Promise.resolve();
  }
}
