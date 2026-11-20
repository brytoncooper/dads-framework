import type { Clock } from "@dads-framework/clock";
import type { EmailSender } from "@dads-framework/email-sender-core";
import { ok, type Result } from "@dads-framework/errors";

import type {
  ClaimedOutboundEmail,
  OutboundEmailStore,
} from "../database/outbound-email-store.js";
import type { EmailDeliveryLog } from "../email-delivery.js";
import type {
  EmailTemplateCatalog,
  EmailTemplate,
  RenderEmailTemplate,
} from "../email-template-port.js";
import { nextAttemptAt } from "../logic/next-attempt-at.js";
import {
  deliveryErrorName,
  summarizeDeliveryError,
} from "../logic/summarize-delivery-error.js";
import { toEmailMessage } from "../logic/to-email-message.js";
import type { OutboundEmailId } from "../outbound-email-status.js";
import {
  SEND_OUTCOME_UNKNOWN_ERROR,
  type LoadEmailAttachment,
  type QueuedEmailAttachment,
} from "../queued-email-attachment.js";

/** A row naming a template this build no longer has. Never retried. */
export const TEMPLATE_UNKNOWN_ERROR = "TEMPLATE_UNKNOWN";

export type DeliverOutboundEmailInput = {
  readonly outboundEmailId: OutboundEmailId;
};

export type DeliverOutboundEmailReport = {
  /**
   * - `sent` — the vendor accepted it.
   * - `skipped` — the row was not claimable: already taken, already settled,
   *   or not due. Ordinary, and the reason a duplicate dispatch is harmless.
   * - `template-unknown` — the row outlived its template; a human decides.
   */
  readonly outcome: "sent" | "skipped" | "template-unknown";
};

export type DeliverOutboundEmailDependencies = {
  readonly loadAttachment?: LoadEmailAttachment;
  readonly store: OutboundEmailStore;
  readonly catalog: EmailTemplateCatalog;
  readonly render: RenderEmailTemplate;
  readonly emailSender: EmailSender;
  readonly clock: Clock;
  readonly log: EmailDeliveryLog;
};

/**
 * Delivers one outbound email: claim it, render it, send it, settle the row.
 *
 * A send that fails settles the row FIRST — retry scheduled or given up on —
 * and only then rethrows. The rethrow is what makes the failure visible as
 * `job.failed` and in `inspect().counts`; the settled row is what makes the
 * retry happen, because the job itself runs once (INV-EMAILDELIVERY-3).
 */
export class DeliverOutboundEmail {
  constructor(
    private readonly dependencies: DeliverOutboundEmailDependencies,
  ) {}

  async execute(
    input: DeliverOutboundEmailInput,
  ): Promise<Result<DeliverOutboundEmailReport>> {
    const { store, catalog, log } = this.dependencies;
    const now = this.dependencies.clock.now();

    const claimed = await store.claimForSending(input.outboundEmailId, now);
    if (!claimed) {
      // Somebody else has it, it is already settled, or it is not due yet.
      log.info({
        event: "email.delivery.skipped",
        outboundEmailId: input.outboundEmailId,
      });
      return ok({ outcome: "skipped" });
    }

    const template = catalog.find(claimed.templateName);
    if (!template) {
      await store.markFailed(claimed.id, { lastError: TEMPLATE_UNKNOWN_ERROR });
      log.error({
        event: "email.delivery.failed",
        outboundEmailId: claimed.id,
        templateName: claimed.templateName,
        attempt: claimed.attempts,
        errorName: TEMPLATE_UNKNOWN_ERROR,
        willRetryAt: null,
      });
      // Not thrown: no number of retries brings a deleted template back, and
      // a job that keeps failing hides the failures that are worth reading.
      return ok({ outcome: "template-unknown" });
    }

    return this.sendClaimed(claimed, template, now);
  }

  private async sendClaimed(
    claimed: ClaimedOutboundEmail,
    template: EmailTemplate,
    now: Date,
  ): Promise<Result<DeliverOutboundEmailReport>> {
    const { store, log } = this.dependencies;
    let transportStarted = false;
    try {
      const rendered = await this.dependencies.render(template, claimed.props);
      const attachments = await this.loadAttachments(claimed);
      transportStarted = true;
      const receipt = await this.dependencies.emailSender.send(
        toEmailMessage(claimed.envelope, rendered, attachments),
      );
      await store.markSent(claimed.id, {
        providerMessageId: receipt.providerMessageId,
        sentAt: this.dependencies.clock.now(),
      });
      log.info({
        event: "email.delivery.sent",
        outboundEmailId: claimed.id,
        templateName: claimed.templateName,
        attempt: claimed.attempts,
        mode: "queued",
      });
      return ok({ outcome: "sent" });
    } catch (error) {
      if (transportStarted && claimed.failurePolicy === "manual-review") {
        await store.markFailed(claimed.id, {
          lastError: `${SEND_OUTCOME_UNKNOWN_ERROR}: ${summarizeDeliveryError(error)}`,
        });
        log.error({
          event: "email.delivery.outcome-unknown",
          outboundEmailId: claimed.id,
          templateName: claimed.templateName,
          errorName: deliveryErrorName(error),
        });
        throw error;
      }
      await this.settleFailure(claimed.id, claimed, error, now);
      throw error;
    }
  }

  private async loadAttachments(claimed: {
    attachments: readonly QueuedEmailAttachment[];
  }) {
    const load = this.dependencies.loadAttachment;
    if (claimed.attachments.length > 0 && load === undefined) {
      throw new Error("Queued email attachment loader is not configured");
    }
    const attachments = [];
    for (const reference of claimed.attachments) {
      if (load === undefined)
        throw new Error("Queued email attachment loader is not configured");
      attachments.push({
        filename: reference.filename,
        contentType: reference.contentType,
        content: await load(reference),
      });
    }
    return attachments;
  }

  /** Schedules the next attempt or gives up, then says so in one log line. */
  private async settleFailure(
    id: OutboundEmailId,
    claimed: { templateName: string; attempts: number },
    error: unknown,
    now: Date,
  ): Promise<void> {
    const { store, log } = this.dependencies;
    const retryAt = nextAttemptAt(claimed.attempts, now);
    const lastError = summarizeDeliveryError(error);

    if (retryAt) {
      await store.markRetryLater(id, { nextAttemptAt: retryAt, lastError });
    } else {
      await store.markFailed(id, { lastError });
    }

    log.error({
      event: "email.delivery.failed",
      outboundEmailId: id,
      templateName: claimed.templateName,
      attempt: claimed.attempts,
      errorName: deliveryErrorName(error),
      willRetryAt: retryAt?.toISOString() ?? null,
    });
  }
}
