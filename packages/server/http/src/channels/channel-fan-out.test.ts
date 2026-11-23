import { describe, expect, it, vi } from "vitest";

import { FakeChannelFanOut } from "../testing/index.js";
import type { ChannelEnvelope } from "./channel-fan-out.js";
import { createChannelFanOut } from "./in-process-channel-fan-out.js";

function makeEnvelope(channel: string, seq: number, payload: unknown = { ok: true }): ChannelEnvelope {
  return {
    channel,
    seq,
    at: "2026-11-23T12:00:00.000Z",
    payload,
  };
}

describe("InProcessChannelFanOut", () => {
  it("delivers envelopes only to subscribers matching both scopeId and channel", () => {
    const fanOut = createChannelFanOut();
    const receivedA: ChannelEnvelope[] = [];
    const receivedB: ChannelEnvelope[] = [];

    const unsubA = fanOut.subscribe("workspace-1", ["orders.updated", "orders.updated"], (event) => {
      receivedA.push(event);
    });
    const unsubB = fanOut.subscribe("workspace-2", ["orders.updated"], (event) => {
      receivedB.push(event);
    });

    const orderEvent = makeEnvelope("orders.updated", 1, { orderId: "ord-1" });
    const billingEvent = makeEnvelope("billing.updated", 2, { invoiceId: "inv-1" });
    const otherScopeEvent = makeEnvelope("orders.updated", 3, { orderId: "ord-2" });

    fanOut.publish("workspace-1", orderEvent);
    fanOut.publish("workspace-1", billingEvent);
    fanOut.publish("workspace-2", otherScopeEvent);

    expect(receivedA).toEqual([orderEvent]);
    expect(receivedB).toEqual([otherScopeEvent]);
    expect(fanOut.subscriberCount()).toBe(2);
    expect(fanOut.subscriberCount("workspace-1")).toBe(1);
    expect(fanOut.subscriberCount("workspace-2")).toBe(1);

    unsubA();
    unsubA();
    expect(fanOut.subscriberCount("workspace-1")).toBe(0);
    expect(fanOut.subscriberCount()).toBe(1);

    unsubB();
    expect(fanOut.subscriberCount()).toBe(0);
  });

  it("isolates throwing and rejecting listeners while logging errors", async () => {
    const errorLog = vi.fn();
    const warnLog = vi.fn();
    const fanOut = createChannelFanOut({
      log: { error: errorLog, warn: warnLog },
    });
    const delivered: ChannelEnvelope[] = [];

    fanOut.subscribe("workspace-1", ["notes.changed"], () => {
      throw new Error("sync boom");
    });
    fanOut.subscribe("workspace-1", ["notes.changed"], () => Promise.reject(new Error("async boom")));
    fanOut.subscribe("workspace-1", ["notes.changed"], (event) => {
      delivered.push(event);
    });

    const envelope = makeEnvelope("notes.changed", 1);
    fanOut.publish("workspace-1", envelope);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(delivered).toEqual([envelope]);
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(warnLog).not.toHaveBeenCalled();
  });

  it("handles empty channel subscriptions and unsubscribing during publish", () => {
    const fanOut = createChannelFanOut();
    const noopUnsub = fanOut.subscribe("workspace-1", [], () => undefined);
    expect(fanOut.subscriberCount()).toBe(0);
    noopUnsub();

    const received: number[] = [];
    const unsubFirst = fanOut.subscribe("workspace-1", ["projects.synced"], (event) => {
      received.push(event.seq);
      unsubFirst();
    });
    fanOut.subscribe("workspace-1", ["projects.synced"], (event) => {
      received.push(event.seq * 10);
    });

    fanOut.publish("workspace-1", makeEnvelope("projects.synced", 1));
    fanOut.publish("workspace-1", makeEnvelope("projects.synced", 2));

    expect(received).toEqual([1, 10, 20]);
    expect(fanOut.subscriberCount("workspace-1")).toBe(1);
  });
});

describe("FakeChannelFanOut", () => {
  it("records published events and delivers live updates to subscribers", () => {
    const fake = new FakeChannelFanOut();
    const received: ChannelEnvelope[] = [];
    const unsubscribe = fake.subscribe("workspace-1", ["documents.updated"], (event) => {
      received.push(event);
    });

    const event = makeEnvelope("documents.updated", 4, { documentId: "doc-9" });
    fake.publish("workspace-1", event);

    expect(fake.published).toEqual([{ scopeId: "workspace-1", envelope: event }]);
    expect(received).toEqual([event]);
    expect(fake.subscriberCount("workspace-1")).toBe(1);

    fake.clearPublished();
    expect(fake.published).toEqual([]);

    unsubscribe();
    expect(fake.subscriberCount()).toBe(0);
  });
});
