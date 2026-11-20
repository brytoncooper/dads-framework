import type {
  FeatureFlagDefinition,
  PublicFeatureState,
} from "../../contract/index.js";
import { evaluateFeatureFlags } from "../logic/evaluate-feature-flags.js";
import type { FeatureFlagStore } from "../ports/feature-flag-store.js";

/**
 * Feature state for signed-out surfaces. Built with the declared public list
 * only and evaluated as the platform, so a tenant pilot never shows and no
 * flag outside the list is ever read.
 */
export class GetPublicFeatureState {
  constructor(
    private readonly publicFlags: readonly FeatureFlagDefinition[],
    private readonly store: FeatureFlagStore,
  ) {}

  async execute(): Promise<PublicFeatureState> {
    const states = await this.store.listStates(
      this.publicFlags.map((definition) => definition.slug),
    );
    const features = evaluateFeatureFlags({
      definitions: this.publicFlags,
      states,
      context: { kind: "platform" },
    });
    return { features: [...features] };
  }
}
