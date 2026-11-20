/**
 * WHAT: the sweep fails claims nobody came back for and dispatches what is
 * due — and, crucially, does not resend the stale claims it just failed.
 *
 * WHY that last one is its own case: "fail the stale claim" and "dispatch the
 * due rows" are one method apart, and the tempting version that re-queues a
 * dead claim is exactly the duplicate-invitation bug INV-EMAILDELIVERY-2 is
 * about.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Clock } from "@dads-framework/runtime/clock";
import type { EmailEnvelope } from "../email-envelope.js";
import type { OutboundEmailId } from "../outbound-email-status.js";
import { FakeOutboundEmailStore } from "../testing/fake-outbound-email-store.js";
import {
  STALE_CLAIM_WINDOW_MS,
  SweepOutboundEmails,
} from "./sweep-outbound-emails.mutation.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - STALE_CLAIM_WINDOW_MS - 60_000);
const ENVELOPE: EmailEnvelope = { to: [{ address: "dana@example.test" }] };

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

describe("SweepOutboundEmails", () => {
  let store: FakeOutboundEmailStore;
  let dispatched: OutboundEmailId[];
  let captured: ReturnType<typeof testLog>;

  beforeEach(() => {
    store = new FakeOutboundEmailStore();
    dispatched = [];
    captured = testLog();
  });

  function build() {
    return new SweepOutboundEmails({
      store,
      delivery: {
        dispatch: (ids) => {
          dispatched.push(...ids);
          return Promise.resolve();
        },
      },
      clock: fixedClock(NOW),
      log: captured.log,
    });
  }

  async function queueOne(sendAt: Date): Promise<OutboundEmailId> {
    const { id } = await store.insert({
      templateName: "email-templates.component-showcase",
      props: {},
      envelope: ENVELOPE,
      sendAt,
    });
    return id;
  }

  it("dispatches every due row and reports the count", async () => {
    const due = await queueOne(NOW);
    await queueOne(new Date(NOW.getTime() + 60_000));

    const result = await build().execute();

    expect(result).toEqual({
      ok: true,
      value: { enqueued: 1, staleFailed: 0 },
    });
    expect(dispatched).toEqual([due]);
  });

  it("fails an abandoned claim and does not resend it", async () => {
    // Queued and claimed long ago, then the worker holding it died.
    const abandoned = await queueOne(LONG_AGO);
    await store.claimForSending(abandoned, LONG_AGO);

    const result = await build().execute();

    expect(result).toEqual({
      ok: true,
      value: { enqueued: 0, staleFailed: 1 },
    });
    expect(store.find(abandoned)).toMatchObject({
      status: "failed",
      lastError: "STALE_CLAIM",
    });
    expect(dispatched).toEqual([]);
  });

  it("leaves a claim that is merely slow alone", async () => {
    // Claimed a second ago — well inside the stale window, still working.
    const working = await queueOne(NOW);
    await store.claimForSending(working, NOW);

    const result = await build().execute();

    expect(result).toEqual({
      ok: true,
      value: { enqueued: 0, staleFailed: 0 },
    });
    expect(store.find(working)?.status).toBe("sending");
  });

  it("reports what it did in one log event with no addresses", async () => {
    await queueOne(NOW);

    await build().execute();

    expect(captured.entries).toEqual([
      { event: "email.sweep.completed", enqueued: 1, staleFailed: 0 },
    ]);
  });
});
