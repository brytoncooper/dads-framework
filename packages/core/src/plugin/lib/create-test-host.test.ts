/**
 * What: clockService, provideClock, overrideService, startTestHost, and createTestHost.
 * Why: domain plugins declare narrow capability dependencies and tests swap implementations
 * cleanly with automatic async disposal.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { Clock, SystemClock } from "../../runtime/clock/index.js";
import { clockService, provideClock } from "./clock-service.js";
import { composeApp } from "./compose-app.js";
import { createTestHost, overrideService, startTestHost } from "./create-test-host.js";
import { definePlugin } from "./define-plugin.js";
import { defineService } from "./define-service.js";
import { PluginCompositionError } from "./plugin-errors.js";
import { providePlugin } from "./provide-plugin.js";

class FixedClock extends Clock {
  private current: Date;

  constructor(initial: Date) {
    super();
    this.current = initial;
  }

  override now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

type CounterStore = { readonly next: () => number };
const counterService = defineService("counter").ofType<CounterStore>();

describe("clockService and provideClock", () => {
  it("provides a Clock to dependent plugins with default or custom plugin names", async () => {
    const fixed = new FixedClock(new Date("2026-06-01T12:00:00.000Z"));
    const provider = provideClock(fixed);
    const customProvider = provideClock(new SystemClock(), "system-clock");
    expect(provider.name).toBe("clock");
    expect(customProvider.name).toBe("system-clock");

    const reader = definePlugin({
      name: "timestamp-reader",
      requires: [clockService],
      setup: ({ use }) => {
        const clock = use(clockService);
        expectTypeOf(clock).toEqualTypeOf<Clock>();
        return { provides: { iso: () => clock.now().toISOString() } };
      },
    });

    const host = await startTestHost(composeApp([reader, provider]));
    try {
      expect(host.read(reader).iso()).toBe("2026-06-01T12:00:00.000Z");
      expectTypeOf(host.read(provider)).toEqualTypeOf<FixedClock>();
      host.read(provider).advanceMs(5_000);
      expect(host.read(reader).iso()).toBe("2026-06-01T12:00:05.000Z");
    } finally {
      await host.stop();
    }
  });
});

describe("overrideService and createTestHost", () => {
  it("replaces an existing service provider and exposes metadata and runtime outputs", async () => {
    const realDisposed = vi.fn();
    const realClock = providePlugin("real-clock", clockService, (scope) => {
      scope.onDispose(realDisposed);
      return new SystemClock();
    });

    const notesDisposed = vi.fn();
    const notesPlugin = definePlugin({
      name: "notes",
      requires: [clockService],
      contributes: {
        access: [{ entity: { wireName: "notes/note" } }],
        flags: [{ slug: "notes.export" }],
        audit: { untrackedTables: ["notes_reads"] },
      },
      setup: ({ scope, use }) => {
        const clock = use(clockService);
        scope.onDispose(notesDisposed);
        return {
          provides: { createdAt: () => clock.now().toISOString() },
          routes: [{ path: "/notes" }],
          jobs: [{ name: "prune-notes" }],
        };
      },
    });

    const fakeClock = new FixedClock(new Date("2026-01-15T00:00:00.000Z"));
    const override = overrideService(clockService, fakeClock);
    expect(override.name).toBe("override-clock");

    const host = await createTestHost({
      plugins: [notesPlugin, realClock],
      overrides: [override],
    });
    try {
      expect(host.plugins).toEqual(["override-clock", "notes"]);
      expect(host.routes).toEqual([{ path: "/notes" }]);
      expect(host.jobs).toEqual([{ name: "prune-notes" }]);
      expect(host.flags).toEqual([{ slug: "notes.export" }]);
      expect(host.access).toEqual([{ entity: { wireName: "notes/note" } }]);
      expect(host.untrackedAuditTables).toEqual(["notes_reads"]);
      expect(host.read(notesPlugin).createdAt()).toBe("2026-01-15T00:00:00.000Z");
      expect(host.read(clockService)).toBe(fakeClock);
      expectTypeOf(host.read(override)).toEqualTypeOf<FixedClock>();
      expect(realDisposed).not.toHaveBeenCalled();
      expect(notesDisposed).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }

    expect(notesDisposed).toHaveBeenCalledTimes(1);
    expect(realDisposed).not.toHaveBeenCalled();
  });

  it("supplies missing service dependencies via overrides when testing one plugin in isolation", async () => {
    const plugin = definePlugin({
      name: "invoice-numbers",
      requires: [clockService, counterService],
      setup: ({ use }) => ({
        provides: {
          issue: () => `${use(clockService).now().getUTCFullYear()}-${String(use(counterService).next())}`,
        },
      }),
    });

    let count = 0;
    const customOverride = overrideService(counterService, { next: () => ++count }, "stub-counter");
    expect(customOverride.name).toBe("stub-counter");

    const host = await createTestHost({
      plugins: [plugin],
      overrides: [overrideService(clockService, new FixedClock(new Date("2027-03-01T00:00:00.000Z"))), customOverride],
    });
    try {
      expect(host.read(plugin).issue()).toBe("2027-1");
      expect(host.read(plugin).issue()).toBe("2027-2");
    } finally {
      await host.stop();
    }
  });

  it("supports selection mode with services, routes, jobs, and overrides", async () => {
    const core = definePlugin({
      name: "core-data",
      requires: [clockService],
      setup: ({ use }) => ({
        provides: { stamp: () => use(clockService).now().getTime() },
        routes: [{ path: "/internal-only" }],
        jobs: [{ name: "internal-job" }],
      }),
    });
    const apiRoutes = definePlugin({
      name: "api-routes",
      requires: [core],
      setup: ({ use }) => ({
        routes: [{ path: `/stamp/${String(use(core).stamp())}` }],
        jobs: [{ name: "ignored-route-job" }],
      }),
    });
    const workerJobs = definePlugin({
      name: "worker-jobs",
      requires: [core],
      setup: () => ({
        routes: [{ path: "/ignored-worker-route" }],
        jobs: [{ name: "nightly-rollup" }],
      }),
    });

    const host = await createTestHost({
      services: [provideClock(new SystemClock()), core],
      routes: [apiRoutes],
      jobs: [workerJobs],
      overrides: [overrideService(clockService, new FixedClock(new Date(42_000)))],
    });
    try {
      expect(host.routes).toEqual([{ path: "/stamp/42000" }]);
      expect(host.jobs).toEqual([{ name: "nightly-rollup" }]);
    } finally {
      await host.stop();
    }
  });

  it("refuses duplicate overrides for the same service and unmet dependencies", async () => {
    const consumer = definePlugin({
      name: "needs-clock",
      requires: [clockService],
      setup: () => ({}),
    });

    await expect(createTestHost({ plugins: [consumer] })).rejects.toThrow(PluginCompositionError);

    await expect(
      createTestHost({
        plugins: [consumer],
        overrides: [
          overrideService(clockService, new FixedClock(new Date(1)), "clock-one"),
          overrideService(clockService, new FixedClock(new Date(2)), "clock-two"),
        ],
      }),
    ).rejects.toThrow(PluginCompositionError);
  });
});
