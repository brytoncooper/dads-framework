/**
 * What: a plugin scope disposes every effect it registered, newest first.
 * Why: nothing a plugin starts may outlive stop(), even when a disposer fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EffectScope, PluginScopeClosedError } from "./plugin-scope.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("EffectScope", () => {
  it("disposes effects newest first and aborts its signal before the first disposer", async () => {
    const scope = new EffectScope("notes");
    const events: string[] = [];
    scope.onDispose(() => {
      events.push(`first, aborted=${String(scope.signal.aborted)}`);
    });
    scope.effect(() => () => {
      events.push("second");
    });

    await scope.dispose();

    expect(events).toEqual(["second", "first, aborted=true"]);
  });

  it("runs every disposer when one throws, and returns the errors", async () => {
    const scope = new EffectScope("notes");
    const ran: string[] = [];
    scope.onDispose(() => {
      ran.push("oldest");
    });
    scope.onDispose(() => {
      throw new Error("socket already closed");
    });
    scope.onDispose(() => {
      ran.push("newest");
    });

    const errors = await scope.dispose();

    expect(ran).toEqual(["newest", "oldest"]);
    expect(errors).toHaveLength(1);
  });

  it("disposes once, however many times it is asked", async () => {
    const scope = new EffectScope("notes");
    const dispose = vi.fn();
    scope.onDispose(dispose);

    await Promise.all([scope.dispose(), scope.dispose()]);
    await scope.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses an effect registered after disposal and does not start it", async () => {
    const scope = new EffectScope("notes");
    await scope.dispose();
    const start = vi.fn(() => () => undefined);

    expect(() => scope.effect(start)).toThrow(PluginScopeClosedError);
    expect(() => {
      scope.onDispose(() => undefined);
    }).toThrow(PluginScopeClosedError);
    expect(start).not.toHaveBeenCalled();
  });

  it("ends one effect early and leaves it out of later disposal", async () => {
    const scope = new EffectScope("notes");
    const dispose = vi.fn();
    const end = scope.effect(() => dispose);

    await end();
    await scope.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scope.ledger()).toEqual({
      pluginName: "notes",
      registered: 1,
      live: 0,
      disposed: true,
    });
  });

  it("clears its interval on disposal", async () => {
    vi.useFakeTimers();
    const scope = new EffectScope("notes");
    const tick = vi.fn();
    scope.interval(tick, 1_000);

    vi.advanceTimersByTime(2_500);
    await scope.dispose();
    vi.advanceTimersByTime(5_000);

    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a fired timeout from its ledger, and clears an unfired one on disposal", async () => {
    vi.useFakeTimers();
    const scope = new EffectScope("notes");
    const fired = vi.fn();
    const neverFires = vi.fn();
    scope.timeout(fired, 100);
    scope.timeout(neverFires, 10_000);

    vi.advanceTimersByTime(200);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(scope.ledger().live).toBe(1);

    await scope.dispose();
    vi.advanceTimersByTime(20_000);
    expect(neverFires).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
