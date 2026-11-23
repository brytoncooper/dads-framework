import type { Clock } from "@dads-framework/core/runtime/clock";
import type { EmailSender } from "../../core/index.js";
import type { JobDefinition } from "@dads-framework/job-queue/core";

import type { OutboundEmailStore } from "./database/outbound-email-store.js";
import type { EmailDelivery, EmailDeliveryLog } from "./email-delivery.js";
import type { EmailTemplateCatalog, RenderEmailTemplate } from "./email-template-port.js";
import { createDeliverOutboundEmailJob } from "./jobs/deliver-outbound-email.job.js";
import { createSweepOutboundEmailsJob } from "./jobs/sweep-outbound-emails.job.js";
import { DeliverOutboundEmail } from "./mutations/deliver-outbound-email.mutation.js";
import { RetryFailedOutboundEmails } from "./mutations/retry-failed-outbound-emails.mutation.js";
import { SendTestEmail } from "./mutations/send-test-email.mutation.js";
import { SweepOutboundEmails } from "./mutations/sweep-outbound-emails.mutation.js";
import type { LoadEmailAttachment } from "./queued-email-attachment.js";

export type EmailDeliveryDeps = {
  readonly loadAttachment?: LoadEmailAttachment;
  /** Built earlier by `createEmailDelivery`, because domains inject it. */
  readonly emailDelivery: EmailDelivery;
  readonly store: OutboundEmailStore;
  readonly emailSender: EmailSender;
  readonly clock: Clock;
  /** Every template this process knows — complete only after every domain assembled. */
  readonly catalog: EmailTemplateCatalog;
  readonly render: RenderEmailTemplate;
  readonly log: EmailDeliveryLog;
};

export type AssembledEmailDelivery = {
  readonly jobs: readonly JobDefinition[];
  /**
   * The three operator operations, for a host that exposes them (an admin
   * route, a CLI). Gating them is the host's job.
   */
  readonly operatorOperations: {
    readonly sendTestEmail: SendTestEmail;
    readonly retryFailedOutboundEmails: RetryFailedOutboundEmails;
    readonly sweepOutboundEmails: SweepOutboundEmails;
  };
};

export type EmailDeliveryJobDependencies = EmailDeliveryDeps;

/** Delivery jobs without an operator portal or that portal's product permissions. */
export function createEmailDeliveryJobs(deps: EmailDeliveryJobDependencies): readonly JobDefinition[] {
  const operations = createDeliveryOperations(deps);
  return [createDeliverOutboundEmailJob(operations.deliver), createSweepOutboundEmailsJob(operations.sweep)];
}

function createDeliveryOperations(deps: EmailDeliveryJobDependencies) {
  return {
    deliver: new DeliverOutboundEmail({
      store: deps.store,
      catalog: deps.catalog,
      render: deps.render,
      emailSender: deps.emailSender,
      clock: deps.clock,
      log: deps.log,
      ...(deps.loadAttachment === undefined ? {} : { loadAttachment: deps.loadAttachment }),
    }),
    sweep: new SweepOutboundEmails({
      store: deps.store,
      delivery: deps.emailDelivery,
      clock: deps.clock,
      log: deps.log,
    }),
  };
}

/**
 * The delivery capability's collect-time half: the two jobs and the three
 * operator operations, returned as data the way every domain returns its own.
 *
 * It runs after the templates exist, which is the whole reason it is separate
 * from `createEmailDelivery` — the delivery job needs a complete catalog, and
 * the catalog is not complete until every domain has been assembled.
 */
export function composeEmailDelivery(deps: EmailDeliveryDeps): AssembledEmailDelivery {
  const operations = createDeliveryOperations(deps);
  const sendTestEmail = new SendTestEmail({
    catalog: deps.catalog,
    emailDelivery: deps.emailDelivery,
  });
  const retryFailedOutboundEmails = new RetryFailedOutboundEmails({
    store: deps.store,
    delivery: deps.emailDelivery,
  });

  return {
    jobs: [createDeliverOutboundEmailJob(operations.deliver), createSweepOutboundEmailsJob(operations.sweep)],
    operatorOperations: {
      sendTestEmail,
      retryFailedOutboundEmails,
      sweepOutboundEmails: operations.sweep,
    },
  };
}
