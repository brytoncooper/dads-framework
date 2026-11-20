/**
 * What: the wire contract refuses definitions that start on or change
 * nothing, slugs outside the format, duplicate selected tenants, and audience
 * detail on the public state.
 * Why: definitions are parsed where they are declared; a bad one must fail at
 * import, not after it reaches a store or a signed-out reader.
 */
import { describe, expect, it } from "vitest";

import { featureFlagDefinitionFactory } from "../testing/feature-flag-definition.factory.js";
import {
  defineFeatureFlag,
  featureFlagDefinitionSchema,
  featureFlagSlugSchema,
  publicFeatureStateSchema,
  updateFeatureFlagsRequestSchema,
} from "./index.js";

describe("feature flag contract", () => {
  it("parses a default-off definition", () => {
    const definition = featureFlagDefinitionFactory();
    expect(defineFeatureFlag(definition)).toEqual(definition);
  });

  it("rejects a definition with no affected page or API capability", () => {
    const result = featureFlagDefinitionSchema.safeParse({
      ...featureFlagDefinitionFactory(),
      affectedPages: [],
      affectedApiCapabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a definition that is on by default", () => {
    const result = featureFlagDefinitionSchema.safeParse({
      ...featureFlagDefinitionFactory(),
      defaultEnabled: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts dotted lowercase slugs and refuses anything else", () => {
    expect(
      featureFlagSlugSchema.safeParse("billing.invoices.bulk-export").success,
    ).toBe(true);
    expect(featureFlagSlugSchema.safeParse("Billing.Invoices").success).toBe(
      false,
    );
    expect(featureFlagSlugSchema.safeParse("billing..invoices").success).toBe(
      false,
    );
  });

  it("rejects duplicate selected tenant ids while keeping concurrency per change", () => {
    const parsed = updateFeatureFlagsRequestSchema.safeParse({
      changes: [
        {
          slug: "orders.bulk-import",
          expectedRevision: 3,
          mode: "SELECTED_TENANTS",
          tenantIds: ["t-1", "t-1"],
        },
      ],
    });
    expect(parsed.success).toBe(false);
    const missingRevision = updateFeatureFlagsRequestSchema.safeParse({
      changes: [{ slug: "orders.bulk-import", mode: "EVERYONE" }],
    });
    expect(missingRevision.success).toBe(false);
  });

  it("refuses audience detail or a state hash alongside the public list", () => {
    expect(publicFeatureStateSchema.safeParse({ features: [] }).success).toBe(
      true,
    );
    expect(
      publicFeatureStateSchema.safeParse({ features: [], stateHash: "x" })
        .success,
    ).toBe(false);
  });
});
