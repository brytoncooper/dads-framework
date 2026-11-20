import type {
  EffectiveFeatureState,
  FeatureFlagDefinition,
} from "../../contract/index.js";
import {
  evaluateFeatureFlags,
  type FeatureFlagContext,
  hashFeatureState,
} from "../logic/evaluate-feature-flags.js";
import type { FeatureFlagStore } from "../ports/feature-flag-store.js";

/** One context's allow-list and its hash, read once and evaluated after the read returns. */
export class GetEffectiveFeatureState {
  constructor(
    private readonly definitions: readonly FeatureFlagDefinition[],
    private readonly store: FeatureFlagStore,
  ) {}

  async execute(context: FeatureFlagContext): Promise<EffectiveFeatureState> {
    const states = await this.store.listStates(
      this.definitions.map((definition) => definition.slug),
    );
    const features = evaluateFeatureFlags({
      definitions: this.definitions,
      states,
      context,
    });
    return { features: [...features], stateHash: hashFeatureState(features) };
  }
}
