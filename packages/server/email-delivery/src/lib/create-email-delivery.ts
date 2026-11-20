import type { Clock } from "@dads-framework/runtime/clock";
import type { EmailSender } from "@dads-framework/email-sender/core";
import type { JobQueue } from "@dads-framework/job-queue/core";

import type { OutboundEmailStore } from "./database/outbound-email-store.js";
import type { EmailDelivery, EmailDeliveryLog } from "./email-delivery.js";
import type { RenderEmailTemplate } from "./email-template-port.js";
import { LiveEmailDelivery } from "./live-email-delivery.js";

export type CreateEmailDeliveryOptions = {
  readonly store: OutboundEmailStore;
  readonly emailSender: EmailSender;
  readonly jobQueue: JobQueue;
  readonly clock: Clock;
  readonly render: RenderEmailTemplate;
  readonly log: EmailDeliveryLog;
};

/**
 * Builds the one `EmailDelivery` a process holds, beside the other shared
 * services. Separate from {@link composeEmailDelivery} because the facade is
 * needed EARLIER than the jobs and actions over it: domains inject it while
 * they assemble, and only once they all exist is there a surface to collect.
 */
export function createEmailDelivery(
  options: CreateEmailDeliveryOptions,
): EmailDelivery {
  return new LiveEmailDelivery(options);
}
