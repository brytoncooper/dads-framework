/**
 * What: the read-once store reads one set of flag states once inside a
 * request scope, reads every time outside one, never shares a read between
 * two scopes, and forgets what it read when a batch is written through it.
 * Why: a read that outlived its request would show one request's flags to
 * the next.
 */
import { describe, expect, it } from "vitest";

import { answeringEachQuestionOnce } from "@dads-framework/request-work";

import type { FeatureFlagState } from "../../contract/index.js";
import { InMemoryFeatureFlagStore } from "../../testing/in-memory-feature-flag-store.js";
import { defaultFeatureFlagState } from "../logic/transition-feature-flag-state.js";
import { ReadStatesOnceFeatureFlagStore } from "./read-states-once-feature-flag-store.js";

const SLUG = "orders.pilot";

/** The fake store, counting its state reads. */
class CountingFeatureFlagStore extends InMemoryFeatureFlagStore {
  reads = 0;

  override listStates(
    slugs: readonly string[],
  ): Promise<readonly FeatureFlagState[]> {
    this.reads += 1;
    return super.listStates(slugs);
  }
}

function storeWithOneFlag() {
  const inner = new CountingFeatureFlagStore();
  inner.seed([defaultFeatureFlagState(SLUG)]);
  return { inner, store: new ReadStatesOnceFeatureFlagStore(inner) };
}

describe("ReadStatesOnceFeatureFlagStore", () => {
  it("reads the same flag states once inside one request scope", async () => {
    const { inner, store } = storeWithOneFlag();
    const [first, second] = await answeringEachQuestionOnce(() =>
      Promise.all([store.listStates([SLUG]), store.listStates([SLUG])]),
    );
    expect(inner.reads).toBe(1);
    expect(second).toEqual(first);
  });

  it("reads every time outside a request scope", async () => {
    const { inner, store } = storeWithOneFlag();
    await store.listStates([SLUG]);
    await store.listStates([SLUG]);
    expect(inner.reads).toBe(2);
  });

  it("never shares a read between two request scopes", async () => {
    const { inner, store } = storeWithOneFlag();
    await answeringEachQuestionOnce(() => store.listStates([SLUG]));
    await answeringEachQuestionOnce(() => store.listStates([SLUG]));
    expect(inner.reads).toBe(2);
  });

  it("reads again after a batch is written through it", async () => {
    const { inner, store } = storeWithOneFlag();
    const after = await answeringEachQuestionOnce(async () => {
      await store.listStates([SLUG]);
      await store.applyBatch({
        expectedRevisions: new Map([[SLUG, 0]]),
        nextStates: [
          { ...defaultFeatureFlagState(SLUG), audienceMode: "EVERYONE" },
        ],
        history: [],
      });
      return store.listStates([SLUG]);
    });
    expect(inner.reads).toBe(2);
    expect(after[0]?.audienceMode).toBe("EVERYONE");
  });
});
