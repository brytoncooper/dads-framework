/**
 * WHAT: re-queuing is the only way back from `failed`, and it re-queues only
 * what actually failed — a `sent` row named in the list stays sent.
 *
 * WHY the dispatch is asserted: a re-queue that never asks for a delivery job
 * leaves the row sitting until the next minute's sweep, which looks like the
 * action did nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { EmailEnvelope } from "../email-envelope.js";
import type { OutboundEmailId } from "../outbound-email-status.js";
import { FakeOutboundEmailStore } from "../testing/fake-outbound-email-store.js";
import { RetryFailedOutboundEmails } from "./retry-failed-outbound-emails.mutation.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const ENVELOPE: EmailEnvelope = { to: [{ address: "dana@example.test" }] };

describe("RetryFailedOutboundEmails", () => {
  let store: FakeOutboundEmailStore;
  let dispatched: OutboundEmailId[];
  let retryFailed: RetryFailedOutboundEmails;

  beforeEach(() => {
    store = new FakeOutboundEmailStore();
    dispatched = [];
    retryFailed = new RetryFailedOutboundEmails({
      store,
      delivery: {
        dispatch: (ids) => {
          dispatched.push(...ids);
          return Promise.resolve();
        },
      },
    });
  });

  async function failOne(): Promise<OutboundEmailId> {
    const { id } = await store.insert({
      templateName: "email-templates.component-showcase",
      props: {},
      envelope: ENVELOPE,
      sendAt: NOW,
    });
    await store.claimForSending(id, NOW);
    await store.markFailed(id, { lastError: "Error: vendor rejected" });
    return id;
  }

  it("re-queues every failed row and asks for its delivery job", async () => {
    const first = await failOne();
    const second = await failOne();

    const result = await retryFailed.execute();

    expect(result).toEqual({ ok: true, value: { requeued: 2 } });
    expect(dispatched).toEqual([first, second]);
    expect(store.find(first)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("re-queues only the rows the operator named", async () => {
    const chosen = await failOne();
    const untouched = await failOne();

    const result = await retryFailed.execute({ outboundEmailIds: [chosen] });

    expect(result).toEqual({ ok: true, value: { requeued: 1 } });
    expect(store.find(untouched)?.status).toBe("failed");
  });

  it("leaves a row that did not fail alone", async () => {
    const { id } = await store.insert({
      templateName: "email-templates.component-showcase",
      props: {},
      envelope: ENVELOPE,
      sendAt: NOW,
    });
    await store.claimForSending(id, NOW);
    await store.markSent(id, { providerMessageId: "mg-1", sentAt: NOW });

    const result = await retryFailed.execute({ outboundEmailIds: [id] });

    expect(result).toEqual({ ok: true, value: { requeued: 0 } });
    expect(store.find(id)?.status).toBe("sent");
    expect(dispatched).toEqual([]);
  });
});
