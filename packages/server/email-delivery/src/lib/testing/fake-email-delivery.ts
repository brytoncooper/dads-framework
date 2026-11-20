import type { EmailDelivery } from "../email-delivery.js";
import {
  type EnqueuedEmail,
  type EnqueueEmailOptions,
  type SendNowOptions,
  type SentEmail,
} from "../email-delivery.js";
import type { EmailEnvelope } from "../email-envelope.js";
import type { EmailTemplate } from "../email-template-port.js";
import type { OutboundEmailId } from "../outbound-email-status.js";
import type {
  EmailFailurePolicy,
  QueuedEmailAttachment,
} from "../queued-email-attachment.js";
import { outboundEmailId } from "./outbound-email.factory.js";

/** One `enqueue`, exactly as the caller asked for it. */
export type FakeEnqueuedEmail = {
  readonly attachments: readonly QueuedEmailAttachment[];
  readonly failurePolicy: EmailFailurePolicy;
  readonly id: OutboundEmailId;
  readonly templateName: string;
  readonly props: Record<string, unknown>;
  readonly envelope: EmailEnvelope;
  readonly sendAt: Date | undefined;
  readonly dedupeKey: string | undefined;
  readonly joinedCallersTransaction: boolean;
};

/** One `sendNow`, exactly as the caller asked for it. */
export type FakeSentEmail = {
  readonly id: OutboundEmailId;
  readonly templateName: string;
  readonly props: Record<string, unknown>;
  readonly envelope: EmailEnvelope;
  readonly attachmentCount: number;
};

/**
 * Stand-in for callers that only need to prove WHAT they asked to send — an
 * identity binding, a mutation, a route. It records and never renders, so a
 * test asserting on an invitation needs neither a template registry nor a
 * vendor.
 *
 * `failEverySendWith` covers the delivery-failure path the way
 * `FakeEmailSender` does one layer down.
 */
export class FakeEmailDelivery implements EmailDelivery {
  readonly enqueued: FakeEnqueuedEmail[] = [];
  readonly sent: FakeSentEmail[] = [];
  readonly dispatched: OutboundEmailId[] = [];
  private sendFailure: Error | undefined;
  private sequence = 0;

  /** Every later `sendNow` rejects with this, after recording the attempt. */
  failEverySendWith(error: Error): void {
    this.sendFailure = error;
  }

  enqueue(
    template: EmailTemplate,
    props: Record<string, unknown>,
    envelope: EmailEnvelope,
    options: EnqueueEmailOptions = {},
  ): Promise<EnqueuedEmail> {
    const id = this.nextId();
    this.enqueued.push({
      id,
      templateName: template.name,
      props,
      envelope,
      sendAt: options.sendAt,
      dedupeKey: options.dedupeKey,
      joinedCallersTransaction: options.tx !== undefined,
      attachments: structuredClone(options.attachments ?? []),
      failurePolicy: options.failurePolicy ?? "retry",
    });
    return Promise.resolve({
      id,
      deduplicated: false,
      dispatched: options.tx === undefined,
    });
  }

  dispatch(ids: readonly OutboundEmailId[]): Promise<void> {
    this.dispatched.push(...ids);
    return Promise.resolve();
  }

  sendNow(
    template: EmailTemplate,
    props: Record<string, unknown>,
    envelope: EmailEnvelope,
    options: SendNowOptions = {},
  ): Promise<SentEmail> {
    const id = this.nextId();
    this.sent.push({
      id,
      templateName: template.name,
      props,
      envelope,
      attachmentCount: options.attachments?.length ?? 0,
    });
    if (this.sendFailure) return Promise.reject(this.sendFailure);
    return Promise.resolve({ id, providerMessageId: `fake-${String(id)}` });
  }

  private nextId(): OutboundEmailId {
    this.sequence += 1;
    return outboundEmailId(this.sequence);
  }
}
