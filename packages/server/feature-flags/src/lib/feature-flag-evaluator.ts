import type { FeatureFlagContext } from "./logic/evaluate-feature-flags.js";
import type { GetEffectiveFeatureState } from "./queries/get-effective-feature-state.js";

/**
 * The server-side capability check: is this flag on in this context? Feature
 * code asks this, never the store, so it cannot see audiences it has no
 * business seeing.
 */
export class FeatureFlagEvaluator {
  constructor(private readonly effective: GetEffectiveFeatureState) {}

  async isActive(input: { readonly slug: string; readonly context: FeatureFlagContext }): Promise<boolean> {
    const state = await this.effective.execute(input.context);
    return state.features.includes(input.slug);
  }
}
