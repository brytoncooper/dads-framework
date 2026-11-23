import { isJsonObject } from "../logic/is-json-object.js";
import { err, notFound, ok, type Result } from "@dads-framework/core/errors";

import type { EmailDelivery } from "../email-delivery.js";
import type { EmailTemplateCatalog } from "../email-template-port.js";
import type { OutboundEmailId } from "../outbound-email-status.js";

/** The tag every test send carries, so vendor reporting can exclude them. */
export const TEST_SEND_TAG = "test-send";

export type SendTestEmailInput = {
  readonly templateName: string;
  readonly sampleName: string;
  readonly to: string;
  /** `immediate` sends in-band and reports the vendor's id; `queued` uses a job. */
  readonly delivery: "queued" | "immediate";
};

export type SendTestEmailReport = {
  readonly outboundEmailId: OutboundEmailId;
  readonly providerMessageId: string | null;
  readonly delivery: "queued" | "immediate";
};

export type SendTestEmailDependencies = {
  readonly catalog: EmailTemplateCatalog;
  readonly emailDelivery: EmailDelivery;
};

/**
 * Sends one template's named sample to an address an operator chose — the
 * "does this actually arrive, and what does it look like" check that
 * otherwise means finding a real user to email.
 *
 * The sample props are the template's own, so nothing here invents data and a
 * test send exercises exactly the path a real one takes.
 */
export class SendTestEmail {
  constructor(private readonly dependencies: SendTestEmailDependencies) {}

  async execute(input: SendTestEmailInput): Promise<Result<SendTestEmailReport>> {
    const template = this.dependencies.catalog.find(input.templateName);
    if (!template) {
      return notFoundResult("EMAIL_TEMPLATE_NOT_FOUND", `No email template is named ${input.templateName}`);
    }

    const sample = template.samples[input.sampleName];
    if (!isJsonObject(sample)) {
      return notFoundResult(
        "EMAIL_TEMPLATE_SAMPLE_NOT_FOUND",
        `Email template ${input.templateName} has no sample named ${input.sampleName}`,
      );
    }

    const envelope = {
      to: [{ address: input.to }],
      tags: [TEST_SEND_TAG],
    };

    if (input.delivery === "immediate") {
      const sent = await this.dependencies.emailDelivery.sendNow(template, sample, envelope);
      return ok({
        outboundEmailId: sent.id,
        providerMessageId: sent.providerMessageId,
        delivery: "immediate",
      });
    }

    const queued = await this.dependencies.emailDelivery.enqueue(template, sample, envelope);
    // A queued send has no vendor id yet — the delivery job writes it onto
    // the row, which is where an operator reads it.
    return ok({
      outboundEmailId: queued.id,
      providerMessageId: null,
      delivery: "queued",
    });
  }
}

function notFoundResult(code: string, message: string): Result<SendTestEmailReport> {
  return err(notFound(code, message));
}
