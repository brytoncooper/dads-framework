import { ok, type Result } from "@dads-framework/errors";

import type { OutboundEmailStore } from "../database/outbound-email-store.js";
import type { EmailDelivery } from "../email-delivery.js";
import type { OutboundEmailId } from "../outbound-email-status.js";

export type RetryFailedOutboundEmailsInput = {
  /** Omitted means every failed row; a list re-queues only those. */
  readonly outboundEmailIds?: readonly OutboundEmailId[];
};

export type RetryFailedOutboundEmailsReport = {
  readonly requeued: number;
};

export type RetryFailedOutboundEmailsDependencies = {
  readonly store: OutboundEmailStore;
  readonly delivery: Pick<EmailDelivery, "dispatch">;
};

/**
 * The operator's way back from `failed` — the only one there is.
 *
 * Nothing re-queues a failed row automatically, by design: a row is failed
 * because its attempts ran out, its template is gone, or its claim went stale
 * and the vendor may already hold the body. Each of those wants a human to
 * look first, which is what makes this an action rather than a job.
 */
export class RetryFailedOutboundEmails {
  constructor(
    private readonly dependencies: RetryFailedOutboundEmailsDependencies,
  ) {}

  async execute(
    input: RetryFailedOutboundEmailsInput = {},
  ): Promise<Result<RetryFailedOutboundEmailsReport>> {
    const requeued = await this.dependencies.store.requeueFailed(
      input.outboundEmailIds,
    );
    await this.dependencies.delivery.dispatch(requeued);
    return ok({ requeued: requeued.length });
  }
}
