/**
 * WHAT: every way one delivery attempt can end — skipped, sent, retried,
 * given up on, or aimed at a template this build no longer has.
 *
 * WHY the rethrow is asserted: the row is settled before it happens, so the
 * throw is purely how the failure becomes visible as `job.failed`. A version
 * that settled and swallowed would pass every other assertion here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { Clock } from "@dads-framework/runtime/clock";
import { FakeEmailSender } from "@dads-framework/email-sender/core/testing";

import type { EmailEnvelope } from "../email-envelope.js";
import type {
  EmailTemplate,
  EmailTemplateCatalog,
} from "../email-template-port.js";
import { MAX_DELIVERY_ATTEMPTS } from "../logic/next-attempt-at.js";
import type { OutboundEmailId } from "../outbound-email-status.js";
import { FakeOutboundEmailStore } from "../testing/fake-outbound-email-store.js";
import {
  DeliverOutboundEmail,
  TEMPLATE_UNKNOWN_ERROR,
} from "./deliver-outbound-email.mutation.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");

const TEMPLATE: EmailTemplate = {
  name: "email-templates.component-showcase",
  props: z.strictObject({ recipientName: z.string() }),
  samples: { default: { recipientName: "Dana Reyes" } },
};

const ENVELOPE: EmailEnvelope = {
  to: [{ address: "dana@example.test" }],
};

const catalog: EmailTemplateCatalog = {
  find: (name) => (name === TEMPLATE.name ? TEMPLATE : undefined),
};

function fixedClock(at: Date): Clock {
  return { now: () => at };
}

function testLog() {
  const entries: object[] = [];
  const record = (obj: object) => {
    entries.push(obj);
  };
  return { entries, log: { info: record, warn: record, error: record } };
}

describe("DeliverOutboundEmail", () => {
  let store: FakeOutboundEmailStore;
  let emailSender: FakeEmailSender;
  let captured: ReturnType<typeof testLog>;

  beforeEach(() => {
    store = new FakeOutboundEmailStore();
    emailSender = new FakeEmailSender();
    captured = testLog();
  });

  function build(templateCatalog: EmailTemplateCatalog = catalog) {
    return new DeliverOutboundEmail({
      store,
      catalog: templateCatalog,
      render: (template) =>
        Promise.resolve({
          subject: `Subject for ${template.name}`,
          html: "<p>hello</p>",
          text: "hello",
        }),
      emailSender,
      clock: fixedClock(NOW),
      log: captured.log,
    });
  }

  async function queueOne(
    templateName = TEMPLATE.name,
  ): Promise<OutboundEmailId> {
    const { id } = await store.insert({
      templateName,
      props: { recipientName: "Dana Reyes" },
      envelope: ENVELOPE,
      sendAt: NOW,
    });
    return id;
  }

  it("skips a row it cannot claim", async () => {
    const id = await queueOne();
    await store.claimForSending(id, NOW);

    const result = await build().execute({ outboundEmailId: id });

    expect(result).toEqual({ ok: true, value: { outcome: "skipped" } });
    expect(emailSender.sent).toEqual([]);
    expect(captured.entries).toContainEqual(
      expect.objectContaining({ event: "email.delivery.skipped" }),
    );
  });

  it("sends the rendered message and marks the row sent", async () => {
    const id = await queueOne();

    const result = await build().execute({ outboundEmailId: id });

    expect(result).toEqual({ ok: true, value: { outcome: "sent" } });
    expect(emailSender.sent[0]).toMatchObject({
      to: ENVELOPE.to,
      subject: `Subject for ${TEMPLATE.name}`,
      text: "hello",
      html: "<p>hello</p>",
    });
    expect(store.find(id)).toMatchObject({
      status: "sent",
      attempts: 1,
      sentAt: NOW,
    });
  });

  it("fails a row whose template this build no longer has, without retrying", async () => {
    const id = await queueOne("identity.removed-template");

    const result = await build().execute({ outboundEmailId: id });

    expect(result).toEqual({
      ok: true,
      value: { outcome: "template-unknown" },
    });
    expect(store.find(id)).toMatchObject({
      status: "failed",
      lastError: TEMPLATE_UNKNOWN_ERROR,
      nextAttemptAt: null,
    });
  });

  it("schedules the next attempt, then rethrows so the job run is counted", async () => {
    const id = await queueOne();
    emailSender.failEverySendWith(new Error("vendor timeout"));

    await expect(build().execute({ outboundEmailId: id })).rejects.toThrow(
      "vendor timeout",
    );

    expect(store.find(id)).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "Error: vendor timeout",
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        event: "email.delivery.failed",
        attempt: 1,
        errorName: "Error",
        willRetryAt: new Date(NOW.getTime() + 30_000).toISOString(),
      }),
    );
  });

  it("gives up after the last attempt instead of scheduling another", async () => {
    const id = await queueOne();
    const row = store.find(id);
    if (!row) throw new Error("expected the row the test just wrote");
    row.attempts = MAX_DELIVERY_ATTEMPTS - 1;
    emailSender.failEverySendWith(new Error("vendor timeout"));

    await expect(build().execute({ outboundEmailId: id })).rejects.toThrow(
      "vendor timeout",
    );

    expect(store.find(id)).toMatchObject({
      status: "failed",
      attempts: MAX_DELIVERY_ATTEMPTS,
      nextAttemptAt: null,
    });
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        event: "email.delivery.failed",
        willRetryAt: null,
      }),
    );
  });

  it("never writes an address or a body into a log event", async () => {
    const id = await queueOne();
    emailSender.failEverySendWith(new Error("dana@example.test was rejected"));

    await build()
      .execute({ outboundEmailId: id })
      .catch(() => undefined);

    const written = JSON.stringify(captured.entries);
    expect(written).not.toContain("dana@example.test");
    expect(written).not.toContain("Dana Reyes");
    expect(written).not.toContain("hello");
  });
});
