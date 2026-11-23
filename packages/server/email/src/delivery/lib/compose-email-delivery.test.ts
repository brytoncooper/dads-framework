/**
 * WHAT: the capability's collect-time surface — exactly two jobs and the
 * three operator operations a host may expose.
 *
 * WHY assert the inventory rather than the wiring: composition is where a new
 * job or action silently fails to be returned, and the registry's own walls
 * (name pattern, description length, permission) only run on what it is
 * handed. This file is what says it was handed everything.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeEmailSender } from "../../core/testing.js";

import { composeEmailDelivery } from "./compose-email-delivery.js";
import type { EmailTemplate, EmailTemplateCatalog } from "./email-template-port.js";
import { EMAIL_DELIVER_JOB, EMAIL_SWEEP_JOB } from "./jobs/email-job-names.js";
import { RetryFailedOutboundEmails } from "./mutations/retry-failed-outbound-emails.mutation.js";
import { SendTestEmail } from "./mutations/send-test-email.mutation.js";
import { SweepOutboundEmails } from "./mutations/sweep-outbound-emails.mutation.js";
import { FakeEmailDelivery } from "./testing/fake-email-delivery.js";
import { FakeOutboundEmailStore } from "./testing/fake-outbound-email-store.js";

const TEMPLATE: EmailTemplate = {
  name: "email-templates.component-showcase",
  props: z.strictObject({}),
  samples: { default: {} },
};

const catalog: EmailTemplateCatalog = {
  find: (name) => (name === TEMPLATE.name ? TEMPLATE : undefined),
};

function compose() {
  return composeEmailDelivery({
    emailDelivery: new FakeEmailDelivery(),
    store: new FakeOutboundEmailStore(),
    emailSender: new FakeEmailSender(),
    clock: { now: () => new Date("2026-09-11T12:00:00.000Z") },
    catalog,
    render: () => Promise.resolve({ subject: "s", html: "<p>h</p>", text: "h" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

describe("composeEmailDelivery", () => {
  it("returns the delivery job and the minute sweep", () => {
    expect(compose().jobs.map((job) => job.name)).toEqual([EMAIL_DELIVER_JOB, EMAIL_SWEEP_JOB]);
  });

  it("returns the three operator operations", () => {
    const { operatorOperations } = compose();

    expect(operatorOperations.sendTestEmail).toBeInstanceOf(SendTestEmail);
    expect(operatorOperations.retryFailedOutboundEmails).toBeInstanceOf(RetryFailedOutboundEmails);
    expect(operatorOperations.sweepOutboundEmails).toBeInstanceOf(SweepOutboundEmails);
  });
});
