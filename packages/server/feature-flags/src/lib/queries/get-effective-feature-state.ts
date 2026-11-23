import type { EffectiveFeatureState, FeatureFlagDefinition } from "../../contract/index.js";
import { evaluateFeatureFlags, type FeatureFlagContext, hashFeatureState } from "../logic/evaluate-feature-flags.js";
import type { FeatureFlagStore } from "../ports/feature-flag-store.js";

export type FeatureFlagPreviewReader = (
  context: FeatureFlagContext,
) => { readonly feature: string; readonly active: boolean } | undefined;

/** One context's allow-list and its hash, read once and evaluated after the read returns. */
export class GetEffectiveFeatureState {
  constructor(
    private readonly definitions: readonly FeatureFlagDefinition[],
    private readonly store: FeatureFlagStore,
    private readonly readPreview?: FeatureFlagPreviewReader,
  ) {}

  async execute(context: FeatureFlagContext): Promise<EffectiveFeatureState> {
    const states = await this.store.listStates(this.definitions.map((definition) => definition.slug));
    const features = evaluateFeatureFlags({
      definitions: this.definitions,
      states,
      context,
    });
    const preview = this.readPreview?.(context);
    if (!preview || !this.definitions.some(({ slug }) => slug === preview.feature)) {
      return { features: [...features], stateHash: hashFeatureState(features) };
    }
    const effective = new Set(features);
    if (preview.active) effective.add(preview.feature);
    else effective.delete(preview.feature);
    const sortedFeatures = [...effective].sort();
    return {
      features: sortedFeatures,
      stateHash: hashFeatureState(sortedFeatures),
    };
  }
}
