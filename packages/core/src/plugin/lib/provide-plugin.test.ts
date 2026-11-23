/**
 * What: providePlugin turns a host-built value or subtype into a plugin
 * implementing a service, with scope-managed disposal.
 * Why: host assemblies often expose extra host-only fields beyond the shared
 * service contract without repeating seven generic arguments to definePlugin.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { composeApp } from "./compose-app.js";
import { definePlugin } from "./define-plugin.js";
import { defineService } from "./define-service.js";
import { providePlugin } from "./provide-plugin.js";

type Clock = {
  readonly now: () => number;
};

type ControllableClock = Clock & {
  readonly advance: (milliseconds: number) => void;
};

const clockService = defineService("clock").ofType<Clock>();

describe("providePlugin", () => {
  it("implements a service with an exact value without explicit generics", async () => {
    const hostClock = providePlugin("host-clock", clockService, () => ({
      now: () => 1_700_000_000_000,
    }));
    const consumer = definePlugin({
      name: "consumer",
      requires: [clockService],
      setup: ({ use }) => ({
        provides: { stampedAt: use(clockService).now() },
      }),
    });

    const running = await composeApp([consumer, hostClock]).start();
    try {
      expect(running.read(consumer)).toEqual({ stampedAt: 1_700_000_000_000 });
      expect(running.read(clockService).now()).toBe(1_700_000_000_000);
      expect(running.read(hostClock).now()).toBe(1_700_000_000_000);
      expectTypeOf(running.read(clockService)).toEqualTypeOf<Clock>();
      expectTypeOf(running.read(hostClock)).toExtend<Clock>();
    } finally {
      await running.stop();
    }
  });

  it("accepts a subtype, exposes the service type to service consumers, and preserves extra fields for direct readers", async () => {
    const createClock = (): Promise<ControllableClock> => {
      let current = 100;
      return Promise.resolve({
        now: () => current,
        advance: (milliseconds: number) => {
          current += milliseconds;
        },
      });
    };

    const hostClock = providePlugin("host-clock", clockService, createClock);

    const serviceConsumer = definePlugin({
      name: "service-consumer",
      requires: [clockService],
      setup: ({ use }) => {
        const clock = use(clockService);
        expectTypeOf(clock).toEqualTypeOf<Clock>();
        return { provides: { readNow: () => clock.now() } };
      },
    });

    const directConsumer = definePlugin({
      name: "direct-consumer",
      requires: [hostClock],
      setup: ({ use }) => {
        const clock = use(hostClock);
        expectTypeOf(clock).toEqualTypeOf<ControllableClock>();
        return {
          provides: {
            step: (milliseconds: number) => {
              clock.advance(milliseconds);
            },
          },
        };
      },
    });

    const running = await composeApp([
      serviceConsumer,
      directConsumer,
      hostClock,
    ]).start();
    try {
      const provided = running.read(hostClock);
      const viaService = running.read(clockService);
      expectTypeOf(provided).toEqualTypeOf<ControllableClock>();
      expectTypeOf(viaService).toEqualTypeOf<Clock>();

      expect(running.read(serviceConsumer).readNow()).toBe(100);
      provided.advance(25);
      expect(running.read(serviceConsumer).readNow()).toBe(125);
      running.read(directConsumer).step(75);
      expect(viaService.now()).toBe(200);
    } finally {
      await running.stop();
    }
  });

  it("infers an inline subtype with extra properties and preserves parameter contextual typing", async () => {
    type Greeter = { readonly greet: (name: string) => string };
    const greeterService = defineService("greeter").ofType<Greeter>();

    const hostGreeter = providePlugin("host-greeter", greeterService, () => ({
      greet: (name) => `hello ${name}`,
      locale: "en-US",
    }));

    const running = await composeApp([hostGreeter]).start();
    try {
      const direct = running.read(hostGreeter);
      expect(direct.greet("ada")).toBe("hello ada");
      expect(direct.locale).toBe("en-US");
      expectTypeOf(direct.locale).toEqualTypeOf<string>();
      expectTypeOf(running.read(greeterService)).toEqualTypeOf<Greeter>();
    } finally {
      await running.stop();
    }
  });

  it("runs scope.onDispose callbacks on stop", async () => {
    const closed = vi.fn();
    const hostClock = providePlugin("host-clock", clockService, (scope) => {
      scope.onDispose(() => {
        closed();
      });
      return {
        now: () => 42,
        advance: () => undefined,
      };
    });

    const running = await composeApp([hostClock]).start();
    expect(closed).not.toHaveBeenCalled();

    await running.stop();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
