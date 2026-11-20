/**
 * What: the in-memory store passes the same conformance suite the Postgres
 * store runs.
 * Why: every unit test in this package and its bindings trusts the stand-in;
 * that trust is only earned if it keeps the port's promises too.
 */
import { describe, expect, it } from "vitest";

import { verifyFeatureFlagStoreConformance } from "./feature-flag-store-conformance.js";
import { InMemoryFeatureFlagStore } from "./in-memory-feature-flag-store.js";

describe("InMemoryFeatureFlagStore", () => {
  it("keeps every FeatureFlagStore promise", async () => {
    await expect(
      verifyFeatureFlagStoreConformance(() =>
        Promise.resolve(new InMemoryFeatureFlagStore()),
      ),
    ).resolves.toBeUndefined();
  });
});
