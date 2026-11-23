/**
 * WHAT: the one decision `LiveEmailDelivery` owns — row now and job next, or
 * vendor now and row after — and what its log events are allowed to carry.
 *
 * WHY the log assertions stringify the whole payload: INV-EMAILDELIVERY-4 is
 * about every field at once, and a per-key assertion passes forever while a
 * new key quietly carries the recipient. The negative assertion is the point
 * of this file, so it is written against the serialized event.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Clock } from "@dads-framework/core/runtime/clock";
import { FakeEmailSender } from "../../core/testing.js";
import { defineJob } from "@dads-framework/job-queue/core";
import { FakeJobQueue } from "@dads-framework/job-queue/core/testing";

import type { EmailEnvelope } from "./email-envelope.js";
import type { EmailTemplate } from "./email-template-port.js";
import { EMAIL_DELIVER_JOB } from "./jobs/email-job-names.js";
import { LiveEmailDelivery } from "./live-email-delivery.js";
import { FakeOutboundEmailStore } from "./testing/fake-outbound-email-store.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const LATER = new Date("2026-09-11T12:30:00.000Z");

const TEMPLATE: EmailTemplate = {
  name: "email-templates.component-showcase",
  props: z.strictObject({ recipientName: z.string() }),
  samples: { default: { recipientName: "Dana Reyes" } },
};

const ENVELOPE: EmailEnvelope = {
  to: [{ address: "dana@example.test", name: "Dana Reyes" }],
  tags: ["test-send"],
};

const PROPS = { recipientName: "Dana Reyes" };

function fixedClock(at: Date): Clock {
  return { now: () => at };
}

function testLog() {
  const entries: object[] = [];
  const record = (obj: object) => {
    entries.push(obj);
  };
  return {
    entries,
    log: { info: record, warn: record, error: record },
  };
}

/** A registered no-op delivery job, so `enqueue` reaches a real name check. */
function registerDeliveryJob(jobQueue: FakeJobQueue): void {
  jobQueue.register([
    defineJob({
      name: EMAIL_DELIVER_JOB,
      payload: z.strictObject({ outboundEmailId: z.string() }),
      retry: { attempts: 1, backoffMs: 1 },
      schedules: [],
      run: () => Promise.resolve(),
    }),
  ]);
}

describe("LiveEmailDelivery", () => {
  let store: FakeOutboundEmailStore;
  let emailSender: FakeEmailSender;
  let jobQueue: FakeJobQueue;

  beforeEach(() => {
    store = new FakeOutboundEmailStore();
    emailSender = new FakeEmailSender();
    jobQueue = new FakeJobQueue();
    registerDeliveryJob(jobQueue);
  });

  function build(overrides: { clock?: Clock; log?: ReturnType<typeof testLog>["log"] } = {}) {
    return new LiveEmailDelivery({
      store,
      emailSender,
      jobQueue,
      clock: overrides.clock ?? fixedClock(NOW),
      render: (template, props) =>
        Promise.resolve({
          subject: `Subject for ${template.name}`,
          html: `<p>${String(props["recipientName"])}</p>`,
          text: `Hello ${String(props["recipientName"])}`,
        }),
      log: overrides.log ?? testLog().log,
    });
  }

  describe("enqueue", () => {
    it("writes a due row and asks for its delivery job", async () => {
      const result = await build().enqueue(TEMPLATE, PROPS, ENVELOPE);

      expect(result).toMatchObject({ deduplicated: false, dispatched: true });
      expect(store.find(result.id)).toMatchObject({
        templateName: TEMPLATE.name,
        status: "queued",
        sendAt: NOW,
      });
      expect(jobQueue.enqueued).toEqual([{ jobName: EMAIL_DELIVER_JOB, payload: { outboundEmailId: result.id } }]);
    });

    it("leaves the dispatch to the caller that owns the transaction", async () => {
      const result = await build().enqueue(TEMPLATE, PROPS, ENVELOPE, {
        tx: { insert: vi.fn() },
      });

      expect(result.dispatched).toBe(false);
      expect(jobQueue.enqueued).toEqual([]);
    });

    it("leaves a future send to the sweep", async () => {
      const result = await build().enqueue(TEMPLATE, PROPS, ENVELOPE, {
        sendAt: LATER,
      });

      expect(result.dispatched).toBe(false);
      expect(store.find(result.id)?.sendAt).toBe(LATER);
      expect(jobQueue.enqueued).toEqual([]);
    });

    it("reports the existing row when a dedupe key is reused", async () => {
      const delivery = build();
      const first = await delivery.enqueue(TEMPLATE, PROPS, ENVELOPE, {
        dedupeKey: "showcase:1",
      });

      const second = await delivery.enqueue(TEMPLATE, PROPS, ENVELOPE, {
        dedupeKey: "showcase:1",
      });

      expect(second).toMatchObject({ id: first.id, deduplicated: true });
      expect(store.rows).toHaveLength(1);
    });

    it("refuses props the template does not accept, writing nothing", async () => {
      await expect(build().enqueue(TEMPLATE, { wrongField: "x" }, ENVELOPE)).rejects.toThrow();

      expect(store.rows).toEqual([]);
    });

    it("refuses an envelope with no recipient, writing nothing", async () => {
      await expect(build().enqueue(TEMPLATE, PROPS, { to: [] })).rejects.toThrow();

      expect(store.rows).toEqual([]);
    });
  });

  describe("dispatch", () => {
    it("warns instead of throwing when the queue refuses the work", async () => {
      const captured = testLog();
      const unregistered = new FakeJobQueue();
      jobQueue = unregistered;
      const delivery = build({ log: captured.log });

      const result = await delivery.enqueue(TEMPLATE, PROPS, ENVELOPE);

      expect(result.dispatched).toBe(true);
      expect(store.find(result.id)?.status).toBe("queued");
      expect(captured.entries).toContainEqual(expect.objectContaining({ event: "email.dispatch.failed" }));
    });
  });

  describe("sendNow", () => {
    it("sends the rendered message and records one settled row", async () => {
      const captured = testLog();

      const result = await build({ log: captured.log }).sendNow(TEMPLATE, PROPS, ENVELOPE);

      expect(emailSender.sent[0]).toMatchObject({
        to: ENVELOPE.to,
        subject: `Subject for ${TEMPLATE.name}`,
        text: "Hello Dana Reyes",
        html: "<p>Dana Reyes</p>",
        tags: ["test-send"],
      });
      expect(store.find(result.id)).toMatchObject({
        status: "sent",
        attempts: 1,
        sentAt: NOW,
      });
      expect(captured.entries).toContainEqual(
        expect.objectContaining({
          event: "email.delivery.sent",
          mode: "immediate",
        }),
      );
    });

    it("counts attachments onto the row without storing their bytes", async () => {
      const result = await build().sendNow(TEMPLATE, PROPS, ENVELOPE, {
        attachments: [
          {
            filename: "slip.pdf",
            contentType: "application/pdf",
            content: new TextEncoder().encode("slip"),
          },
        ],
      });

      expect(store.find(result.id)?.attachmentCount).toBe(1);
      expect(JSON.stringify(store.find(result.id))).not.toContain("slip.pdf");
    });

    it("records the failure, then rethrows so the caller learns", async () => {
      const captured = testLog();
      emailSender.failEverySendWith(new Error("Mailgun rejected the email"));
      const delivery = build({ log: captured.log });

      await expect(delivery.sendNow(TEMPLATE, PROPS, ENVELOPE)).rejects.toThrow("Mailgun rejected the email");

      expect(store.rows[0]).toMatchObject({
        status: "failed",
        lastError: "Error: Mailgun rejected the email",
        providerMessageId: null,
      });
      expect(captured.entries).toContainEqual(
        expect.objectContaining({
          event: "email.delivery.failed",
          errorName: "Error",
        }),
      );
    });
  });

  it("never writes an address, subject or body into a log event", async () => {
    const captured = testLog();
    const delivery = build({ log: captured.log });

    await delivery.enqueue(TEMPLATE, PROPS, ENVELOPE);
    await delivery.sendNow(TEMPLATE, PROPS, ENVELOPE);
    emailSender.failEverySendWith(new Error("dana@example.test was rejected"));
    await delivery.sendNow(TEMPLATE, PROPS, ENVELOPE).catch(() => undefined);

    const written = JSON.stringify(captured.entries);
    expect(written).not.toContain("dana@example.test");
    expect(written).not.toContain("Dana Reyes");
    expect(written).not.toContain("Subject for");
    expect(written).not.toContain("Hello ");
  });
});
