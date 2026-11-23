/**
 * What: the testing harness stops a plugin set and refuses leftovers.
 * Why: a test must be able to prove a plugin set stops clean.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeApp } from "../lib/compose-app.js";
import { definePlugin } from "../lib/define-plugin.js";
import { PluginLeakError, startForTest } from "./start-for-test.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startForTest", () => {
  it("passes a plugin set whose timers are all registered on its scope", async () => {
    vi.useFakeTimers();
    const ticking = definePlugin({
      name: "ticking",
      setup: ({ scope }) => {
        scope.interval(() => undefined, 1_000);
        return {};
      },
    });
    const harness = await startForTest(composeApp([ticking]), {
      leakProbe: () => vi.getTimerCount(),
    });

    expect(vi.getTimerCount()).toBe(1);
    await expect(harness.stopCleanly()).resolves.toBeUndefined();
  });

  it("refuses a plugin that started a timer outside its scope", async () => {
    vi.useFakeTimers();
    const leaking = definePlugin({
      name: "leaking",
      setup: () => {
        setInterval(() => undefined, 1_000);
        return {};
      },
    });
    const harness = await startForTest(composeApp([leaking]), {
      leakProbe: () => vi.getTimerCount(),
    });

    await expect(harness.stopCleanly()).rejects.toThrow(PluginLeakError);
    vi.clearAllTimers();
  });
});
