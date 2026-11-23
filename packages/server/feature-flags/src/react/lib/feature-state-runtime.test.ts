/**
 * What: an unhydrated context reads every feature off, each context keeps
 * its own flags and hash, hash drift refreshes once, and a failed refresh
 * keeps the last known flags.
 * Why: a gate that flickers off on a network blip, or that shows one
 * tenant's flags inside another, is worse than no gate.
 */
import { describe, expect, it, vi } from "vitest";

import type { EffectiveFeatureState } from "../../contract/index.js";

import { type FeatureStateLoader, FeatureStateRuntime } from "./feature-state-runtime.js";

function loaderFrom(states: Readonly<Record<string, EffectiveFeatureState>>): FeatureStateLoader {
  return (contextKey) => {
    const state = states[contextKey];
    return state === undefined ? Promise.reject(new Error(`no state for ${contextKey}`)) : Promise.resolve(state);
  };
}

describe("FeatureStateRuntime", () => {
  it("defaults an unhydrated context to every feature off", () => {
    const runtime = new FeatureStateRuntime(loaderFrom({}));
    expect(runtime.snapshot("t-1")).toMatchObject({
      features: [],
      hydrated: false,
    });
    expect(runtime.isEnabled("t-1", "orders.bulk")).toBe(false);
  });

  it("reuses one snapshot per context until that context's state changes", async () => {
    const runtime = new FeatureStateRuntime(loaderFrom({ "t-1": { features: ["orders.bulk"], stateHash: "a" } }));
    const first = runtime.snapshot("t-1");
    expect(runtime.snapshot("t-1")).toBe(first);
    expect(runtime.snapshot("t-2")).not.toBe(first);
    await runtime.hydrate("t-1");
    const hydrated = runtime.snapshot("t-1");
    expect(hydrated).not.toBe(first);
    expect(hydrated.features).toEqual(["orders.bulk"]);
  });

  it("uses the stored hash for each context independently", async () => {
    const runtime = new FeatureStateRuntime(
      loaderFrom({
        "t-1": { features: ["orders.bulk"], stateHash: "one" },
        "t-2": { features: [], stateHash: "two" },
      }),
    );
    await runtime.hydrate("t-1");
    await runtime.hydrate("t-2");
    expect(runtime.hashFor("t-1")).toBe("one");
    expect(runtime.hashFor("t-2")).toBe("two");
    expect(runtime.isEnabled("t-2", "orders.bulk")).toBe(false);
  });

  it("coalesces hash drift to one refresh for that context", async () => {
    let release: (() => void) | undefined;
    const load = vi.fn<FeatureStateLoader>(
      () =>
        new Promise<EffectiveFeatureState>((resolve) => {
          release = () => {
            resolve({ features: ["orders.bulk"], stateHash: "next" });
          };
        }),
    );
    const runtime = new FeatureStateRuntime(load);
    runtime.observeResponse({ contextKey: "t-1", stateHash: "next" });
    runtime.observeResponse({ contextKey: "t-1", stateHash: "next" });
    expect(load).toHaveBeenCalledTimes(1);
    release?.();
    await runtime.hydrate("t-1");
    runtime.observeResponse({ contextKey: "t-1", stateHash: "next" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(runtime.isEnabled("t-1", "orders.bulk")).toBe(true);
  });

  it("keeps the last known flags when a later refresh fails", async () => {
    let fail = false;
    const runtime = new FeatureStateRuntime((contextKey) =>
      fail
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ features: [`${contextKey}.flag`], stateHash: "h" }),
    );
    await runtime.hydrate("t-1");
    fail = true;
    await runtime.hydrate("t-1");
    expect(runtime.snapshot("t-1")).toMatchObject({
      features: ["t-1.flag"],
      hydrated: true,
      refreshFailed: true,
    });
  });

  it("tells subscribers when a context's state changes", async () => {
    const runtime = new FeatureStateRuntime(loaderFrom({ "t-1": { features: [], stateHash: "a" } }));
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    await runtime.hydrate("t-1");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await runtime.hydrate("t-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
