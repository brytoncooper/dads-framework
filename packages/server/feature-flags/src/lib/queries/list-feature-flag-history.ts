import { notFound } from "@dads-framework/errors";

import type {
  FeatureFlagDefinition,
  FeatureFlagHistoryEntry,
} from "../../contract/index.js";
import type { FeatureFlagStore } from "../ports/feature-flag-store.js";

/** History for flags that are still defined in code; any other slug is not found. */
export class ListFeatureFlagHistory {
  constructor(
    private readonly definitions: readonly FeatureFlagDefinition[],
    private readonly store: FeatureFlagStore,
  ) {}

  async execute(input: {
    readonly slug: string;
    readonly page: number;
    readonly perPage: number;
  }): Promise<{
    readonly items: readonly FeatureFlagHistoryEntry[];
    readonly total: number;
  }> {
    if (!this.definitions.some((definition) => definition.slug === input.slug))
      throw notFound("FEATURE_FLAG_NOT_FOUND", "Feature flag was not found");
    const page = await this.store.listHistory(input);
    return { items: page.rows, total: page.total };
  }
}
