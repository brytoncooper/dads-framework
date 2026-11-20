import type { FeatureFlagDefinition } from "../contract/index.js";

/** A valid definition for tests; override what the test is about. */
export function featureFlagDefinitionFactory(
  overrides: Partial<FeatureFlagDefinition> = {},
): FeatureFlagDefinition {
  return {
    slug: "orders.bulk-import",
    name: "Bulk import",
    description: "Lets operators import orders from a spreadsheet.",
    owner: "orders team",
    defaultEnabled: false,
    affectedPages: ["/orders/import"],
    affectedApiCapabilities: [],
    cleanupTrigger: "Removed once every tenant has used it for a month.",
    globalStabilityDays: 14,
    ...overrides,
  };
}
