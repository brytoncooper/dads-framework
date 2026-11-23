import type { Clock } from "@dads-framework/core/runtime/clock";
import { ok, type Result } from "@dads-framework/core/errors";

import type { OutboundEmailStore } from "../database/outbound-email-store.js";
import type { EmailDelivery, EmailDeliveryLog } from "../email-delivery.js";

/**
 * How long a claim may sit in `sending` before the sweep calls it dead. Long
 * enough that a slow vendor is not mistaken for a crashed worker.
 */
export const STALE_CLAIM_WINDOW_MS = 600_000;

/** One sweep's ceiling, so a backlog drains over minutes rather than at once. */
export const SWEEP_BATCH_LIMIT = 500;

export type SweepOutboundEmailsReport = {
  /** Rows that were due and now have a delivery job. */
  readonly enqueued: number;
  /** Claims abandoned by a crashed worker, now `failed` for an operator. */
  readonly staleFailed: number;
};

export type SweepOutboundEmailsDependencies = {
  readonly store: OutboundEmailStore;
  /** Only the dispatch half of the facade — the sweep never enqueues a row. */
  readonly delivery: Pick<EmailDelivery, "dispatch">;
  readonly clock: Clock;
  readonly log: EmailDeliveryLog;
};

/**
 * The minute hand of the outbox: it fails claims nobody came back for, then
 * gives every due row a delivery job.
 *
 * A stale claim is FAILED, never re-sent. The worker that took it may have
 * died after the vendor accepted the body, and a duplicate invitation is
 * worse than a late one — so a human decides (INV-EMAILDELIVERY-2).
 */
export class SweepOutboundEmails {
  constructor(private readonly dependencies: SweepOutboundEmailsDependencies) {}

  async execute(): Promise<Result<SweepOutboundEmailsReport>> {
    const { store, log } = this.dependencies;
    const now = this.dependencies.clock.now();

    const staleFailed = await store.failStaleClaims(new Date(now.getTime() - STALE_CLAIM_WINDOW_MS));
    const due = await store.listDue(now, SWEEP_BATCH_LIMIT);
    await this.dependencies.delivery.dispatch(due);

    log.info({
      event: "email.sweep.completed",
      enqueued: due.length,
      staleFailed: staleFailed.length,
    });
    return ok({ enqueued: due.length, staleFailed: staleFailed.length });
  }
}
