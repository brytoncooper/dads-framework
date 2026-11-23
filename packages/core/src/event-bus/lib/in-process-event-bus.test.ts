import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "./in-process-event-bus.js";

describe("InProcessEventBus", () => {
  it("delivers a published payload to every subscriber of that event", async () => {
    const bus = new InProcessEventBus(() => undefined);
    const seen: unknown[] = [];
    bus.subscribe("organization.deleted", (payload) => {
      seen.push(payload);
      return Promise.resolve();
    });
    bus.subscribe("organization.deleted", (payload) => {
      seen.push(payload);
      return Promise.resolve();
    });
    bus.subscribe("other.event", () => {
      seen.push("wrong");
      return Promise.resolve();
    });

    await bus.publish("organization.deleted", { organizationId: "org-1" });

    expect(seen).toEqual([{ organizationId: "org-1" }, { organizationId: "org-1" }]);
  });

  it("isolates a throwing handler — later subscribers still run, publish resolves", async () => {
    const errors: string[] = [];
    const bus = new InProcessEventBus((eventName) => {
      errors.push(eventName);
    });
    const seen: string[] = [];
    bus.subscribe("organization.deleted", () => {
      throw new Error("subscriber exploded");
    });
    bus.subscribe("organization.deleted", () => {
      seen.push("second ran");
      return Promise.resolve();
    });

    await expect(bus.publish("organization.deleted", {})).resolves.toBeUndefined();
    expect(errors).toEqual(["organization.deleted"]);
    expect(seen).toEqual(["second ran"]);
  });

  it("publishing with no subscribers is a no-op", async () => {
    const bus = new InProcessEventBus(() => undefined);
    await expect(bus.publish("nobody.listens", {})).resolves.toBeUndefined();
  });
});
