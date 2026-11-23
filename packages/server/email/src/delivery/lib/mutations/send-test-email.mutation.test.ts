/**
 * WHAT: a test send resolves a template's own named sample, tags the message,
 * and reports which path it took — plus the two not-found cases an operator
 * hits by typing a name wrong in the portal form.
 *
 * WHY typed errors rather than thrown ones: these come back through the
 * live-environment-action handler as a `Result`, which is what turns them
 * into a 404 the operator can read instead of a 500.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { EmailTemplate, EmailTemplateCatalog } from "../email-template-port.js";
import { FakeEmailDelivery } from "../testing/fake-email-delivery.js";
import { SendTestEmail, TEST_SEND_TAG } from "./send-test-email.mutation.js";

const TEMPLATE: EmailTemplate = {
  name: "email-templates.component-showcase",
  props: z.strictObject({ recipientName: z.string() }),
  samples: {
    default: { recipientName: "Dana Reyes" },
    "long-names": { recipientName: "Aleksandra Wieczorkiewicz-Nowakowska" },
  },
};

const catalog: EmailTemplateCatalog = {
  find: (name) => (name === TEMPLATE.name ? TEMPLATE : undefined),
};

describe("SendTestEmail", () => {
  let emailDelivery: FakeEmailDelivery;
  let sendTestEmail: SendTestEmail;

  beforeEach(() => {
    emailDelivery = new FakeEmailDelivery();
    sendTestEmail = new SendTestEmail({ catalog, emailDelivery });
  });

  it("queues the template's own sample, tagged as a test send", async () => {
    const result = await sendTestEmail.execute({
      templateName: TEMPLATE.name,
      sampleName: "long-names",
      to: "ops@test.example",
      delivery: "queued",
    });

    expect(result.ok).toBe(true);
    expect(emailDelivery.enqueued[0]).toMatchObject({
      templateName: TEMPLATE.name,
      props: TEMPLATE.samples["long-names"],
      envelope: {
        to: [{ address: "ops@test.example" }],
        tags: [TEST_SEND_TAG],
      },
    });
    expect(result.ok && result.value.delivery).toBe("queued");
    // The vendor id is written onto the row by the delivery job, not here.
    expect(result.ok && result.value.providerMessageId).toBeNull();
  });

  it("reports the vendor's id when the operator asks for an immediate send", async () => {
    const result = await sendTestEmail.execute({
      templateName: TEMPLATE.name,
      sampleName: "default",
      to: "ops@test.example",
      delivery: "immediate",
    });

    expect(emailDelivery.sent).toHaveLength(1);
    expect(emailDelivery.enqueued).toEqual([]);
    expect(result.ok && result.value.delivery).toBe("immediate");
    expect(result.ok ? result.value.providerMessageId : null).toMatch(/^fake-/);
  });

  it("reports a template nobody has by that name", async () => {
    const result = await sendTestEmail.execute({
      templateName: "identity.not-a-template",
      sampleName: "default",
      to: "ops@test.example",
      delivery: "queued",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("EMAIL_TEMPLATE_NOT_FOUND");
    expect(emailDelivery.enqueued).toEqual([]);
  });

  it("reports a sample the template does not have", async () => {
    const result = await sendTestEmail.execute({
      templateName: TEMPLATE.name,
      sampleName: "not-a-sample",
      to: "ops@test.example",
      delivery: "queued",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("EMAIL_TEMPLATE_SAMPLE_NOT_FOUND");
    expect(emailDelivery.enqueued).toEqual([]);
  });
});
