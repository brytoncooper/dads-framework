import { isJsonObject } from "./logic/is-json-object.js";
import type { Clock } from "@dads-framework/runtime/clock";
import type { EmailSender } from "@dads-framework/email-sender/core";
import type { JobQueue } from "@dads-framework/job-queue/core";

import type { OutboundEmailStore } from "./database/outbound-email-store.js";
import type { EmailDelivery } from "./email-delivery.js";
import {
  type EmailDeliveryLog,
  type EnqueuedEmail,
  type EnqueueEmailOptions,
  type SendNowOptions,
  type SentEmail,
} from "./email-delivery.js";
import { type EmailEnvelope, emailEnvelopeSchema } from "./email-envelope.js";
import type {
  EmailTemplate,
  RenderEmailTemplate,
} from "./email-template-port.js";
import { EMAIL_DELIVER_JOB } from "./jobs/email-job-names.js";
import {
  deliveryErrorName,
  summarizeDeliveryError,
} from "./logic/summarize-delivery-error.js";
import { toEmailMessage } from "./logic/to-email-message.js";
import type { OutboundEmailId } from "./outbound-email-status.js";
import { queuedEmailAttachmentsSchema } from "./queued-email-attachment.js";

export type LiveEmailDeliveryDependencies = {
  readonly store: OutboundEmailStore;
  readonly emailSender: EmailSender;
  readonly jobQueue: JobQueue;
  readonly clock: Clock;
  readonly render: RenderEmailTemplate;
  readonly log: EmailDeliveryLog;
};

/**
 * The real facade. It owns one decision — row now and job next, or vendor now
 * and row after — and delegates everything else: the store keeps the state,
 * the sender talks to the vendor, the queue decides when work runs.
 *
 * Nothing here logs an address, a subject or a body (INV-EMAILDELIVERY-4):
 * every event carries the row's id, the template's name, and the error's
 * class.
 */
export class LiveEmailDelivery implements EmailDelivery {
  constructor(private readonly dependencies: LiveEmailDeliveryDependencies) {}

  async enqueue(
    template: EmailTemplate,
    props: Record<string, unknown>,
    envelope: EmailEnvelope,
    options: EnqueueEmailOptions = {},
  ): Promise<EnqueuedEmail> {
    const parsedProps = parseProps(template, props);
    const parsedEnvelope = emailEnvelopeSchema.parse(envelope);
    const now = this.dependencies.clock.now();
    const sendAt = options.sendAt ?? now;

    const { id, deduplicated } = await this.dependencies.store.insert(
      {
        templateName: template.name,
        props: parsedProps,
        envelope: parsedEnvelope,
        sendAt,
        dedupeKey: options.dedupeKey ?? null,
        attachments: queuedEmailAttachmentsSchema.parse(
          options.attachments ?? [],
        ),
        failurePolicy: options.failurePolicy ?? "retry",
      },
      options.tx,
    );

    // With a transaction the row does not exist for anyone else yet, and a
    // future `sendAt` belongs to the sweep — both are somebody else's cue.
    const dispatchNow =
      options.tx === undefined && sendAt.getTime() <= now.getTime();
    if (dispatchNow) await this.dispatch([id]);
    return { id, deduplicated, dispatched: dispatchNow };
  }

  async dispatch(ids: readonly OutboundEmailId[]): Promise<void> {
    for (const outboundEmailId of ids) {
      try {
        await this.dependencies.jobQueue.enqueue(EMAIL_DELIVER_JOB, {
          outboundEmailId,
        });
      } catch (error) {
        // The row is already durable, so a queue that refuses work costs a
        // minute, not a message — the sweep finds it again.
        this.dependencies.log.warn(
          {
            event: "email.dispatch.failed",
            outboundEmailId,
            errorName: deliveryErrorName(error),
          },
          "could not enqueue an email delivery job",
        );
      }
    }
  }

  async sendNow(
    template: EmailTemplate,
    props: Record<string, unknown>,
    envelope: EmailEnvelope,
    options: SendNowOptions = {},
  ): Promise<SentEmail> {
    const parsedProps = parseProps(template, props);
    const parsedEnvelope = emailEnvelopeSchema.parse(envelope);
    const attachments = options.attachments ?? [];
    const at = this.dependencies.clock.now();

    try {
      const rendered = await this.dependencies.render(template, parsedProps);
      const receipt = await this.dependencies.emailSender.send(
        toEmailMessage(parsedEnvelope, rendered, attachments),
      );
      const { id } = await this.dependencies.store.recordImmediate({
        templateName: template.name,
        props: parsedProps,
        envelope: parsedEnvelope,
        status: "sent",
        providerMessageId: receipt.providerMessageId,
        lastError: null,
        attachmentCount: attachments.length,
        at,
      });
      this.dependencies.log.info({
        event: "email.delivery.sent",
        outboundEmailId: id,
        templateName: template.name,
        mode: "immediate",
      });
      return { id, providerMessageId: receipt.providerMessageId };
    } catch (error) {
      const { id } = await this.dependencies.store.recordImmediate({
        templateName: template.name,
        props: parsedProps,
        envelope: parsedEnvelope,
        status: "failed",
        providerMessageId: null,
        lastError: summarizeDeliveryError(error),
        attachmentCount: attachments.length,
        at,
      });
      this.dependencies.log.error({
        event: "email.delivery.failed",
        outboundEmailId: id,
        templateName: template.name,
        mode: "immediate",
        errorName: deliveryErrorName(error),
      });
      // The caller asked to send in-band precisely so it would learn this.
      throw error;
    }
  }
}

/**
 * Props as the template accepts them, still JSON-shaped so they can be stored.
 * A template whose parser refuses is a programming error, not a delivery
 * failure, so this throws rather than recording a row nobody can send.
 */
function parseProps(
  template: EmailTemplate,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const parsed: unknown = template.props.parse(props);
  if (!isJsonObject(parsed)) {
    throw new Error(
      `Email template ${template.name} parsed its props into something that is not an object`,
    );
  }
  return parsed;
}
