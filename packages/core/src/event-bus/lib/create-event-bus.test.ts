/**
 * createEventBus wires handler failures into the log, never as unhandled
 * rejections.
 */
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "./create-event-bus.js";

describe("createEventBus", () => {
  it("delivers events and logs handler failures", async () => {
    const log = { error: vi.fn() };
    const bus = createEventBus(log);
    const seen: unknown[] = [];
    bus.subscribe("thing.happened", (payload) => {
      seen.push(payload);
      return Promise.resolve();
    });
    bus.subscribe("thing.happened", () => {
      throw new Error("handler blew up");
    });
    await bus.publish("thing.happened", { id: "t1" });
    expect(seen).toEqual([{ id: "t1" }]);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "thing.happened" }),
      expect.any(String),
    );
  });
});
