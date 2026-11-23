import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeEmailSender } from "../../../core/testing.js";

import { FakeOutboundEmailStore } from "../testing/fake-outbound-email-store.js";
import { DeliverOutboundEmail } from "./deliver-outbound-email.mutation.js";

const NOW = new Date("2026-10-18T01:00:00.000Z");
const reference = {
  objectKey: "vector/purchase-orders/po-1/revisions/1.pdf",
  filename: "PO-1001.pdf",
  contentType: "application/pdf",
  byteSize: 3,
  sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
};
const template = {
  name: "vector.purchase-order",
  props: z.strictObject({}),
  samples: { default: {} },
};
const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function setup() {
  const store = new FakeOutboundEmailStore();
  const emailSender = new FakeEmailSender();
  const queued = {
    templateName: template.name,
    props: {},
    envelope: { to: [{ address: "vendor@example.test" }] },
    sendAt: NOW,
    attachments: [reference],
    failurePolicy: "manual-review" as const,
  };
  const { id } = await store.insert(queued);
  const loaded: string[] = [];
  const dependencies = {
    store,
    emailSender,
    clock: { now: () => NOW },
    catalog: { find: () => template },
    render: () => Promise.resolve({ subject: "PO-1001", html: "", text: "PO" }),
    loadAttachment: (file: typeof reference) => {
      loaded.push(file.objectKey);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
    log,
  };
  return { id, store, emailSender, loaded, dependencies };
}

describe("queued document email", () => {
  it("loads the immutable attachment reference at delivery and sends its bytes", async () => {
    const test = await setup();

    await new DeliverOutboundEmail(test.dependencies).execute({
      outboundEmailId: test.id,
    });

    expect(test.loaded).toEqual([reference.objectKey]);
    expect(test.emailSender.sent[0]?.attachments).toEqual([
      {
        filename: reference.filename,
        contentType: reference.contentType,
        content: new Uint8Array([1, 2, 3]),
      },
    ]);
  });

  it("requires manual review after an uncertain transport result", async () => {
    const test = await setup();
    test.emailSender.failEverySendWith(new Error("connection closed"));

    await expect(
      new DeliverOutboundEmail(test.dependencies).execute({
        outboundEmailId: test.id,
      }),
    ).rejects.toThrow();

    const stored = test.store.find(test.id);
    expect(stored).toMatchObject({
      status: "failed",
      nextAttemptAt: null,
    });
    expect(stored?.lastError).toContain("SEND_OUTCOME_UNKNOWN");
  });
});
