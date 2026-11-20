import type { Clock } from "@dads-framework/clock";

import type { FeatureFlagDefinition } from "../contract/index.js";
import { FeatureFlagEvaluator } from "./feature-flag-evaluator.js";
import { UpdateFeatureFlags } from "./mutations/update-feature-flags.js";
import type { FeatureFlagStore } from "./ports/feature-flag-store.js";
import type { TenantDirectory } from "./ports/tenant-directory.js";
import {
  type FeatureFlagPreviewReader,
  GetEffectiveFeatureState,
} from "./queries/get-effective-feature-state.js";
import { GetPublicFeatureState } from "./queries/get-public-feature-state.js";
import { ListFeatureFlagHistory } from "./queries/list-feature-flag-history.js";
import { ListFeatureFlagManagement } from "./queries/list-feature-flag-management.js";
import { ReadStatesOnceFeatureFlagStore } from "./stores/read-states-once-feature-flag-store.js";

export type FeatureFlagsDeps = {
  /** Every flag the application defines in code. Nothing else can become a feature. */
  readonly definitions: readonly FeatureFlagDefinition[];
  /**
   * Slugs a signed-out reader may learn about. Each must be defined. Adding
   * one is a reviewed code change, never a runtime setting.
   */
  readonly publicSlugs?: readonly string[];
  readonly readPreview?: FeatureFlagPreviewReader;
  readonly store: FeatureFlagStore;
  readonly tenants: TenantDirectory;
  readonly clock: Clock;
};

export type FeatureFlags = {
  readonly management: ListFeatureFlagManagement;
  readonly history: ListFeatureFlagHistory;
  readonly update: UpdateFeatureFlags;
  readonly effective: GetEffectiveFeatureState;
  readonly publicState: GetPublicFeatureState;
  readonly evaluator: FeatureFlagEvaluator;
  /**
   * The same answers, reading flag states once per request: for a request
   * that asks many flags. Never for work that outlives its request, which
   * would keep the request's first read.
   */
  readonly evaluatorReadingStatesOncePerRequest: FeatureFlagEvaluator;
};

/** Wires code-owned definitions to stored audience state. Definitions are never stored. */
export function composeFeatureFlags(deps: FeatureFlagsDeps): FeatureFlags {
  assertSlugsDefinedOnce(deps.definitions);
  const effective = new GetEffectiveFeatureState(
    deps.definitions,
    deps.store,
    deps.readPreview,
  );
  return {
    management: new ListFeatureFlagManagement(
      deps.definitions,
      deps.store,
      deps.tenants,
      deps.clock,
    ),
    history: new ListFeatureFlagHistory(deps.definitions, deps.store),
    update: new UpdateFeatureFlags(
      deps.definitions,
      deps.store,
      deps.tenants,
      deps.clock,
    ),
    effective,
    publicState: new GetPublicFeatureState(
      publicDefinitions(deps.definitions, deps.publicSlugs ?? []),
      deps.store,
    ),
    evaluator: new FeatureFlagEvaluator(effective),
    evaluatorReadingStatesOncePerRequest: new FeatureFlagEvaluator(
      new GetEffectiveFeatureState(
        deps.definitions,
        new ReadStatesOnceFeatureFlagStore(deps.store),
        deps.readPreview,
      ),
    ),
  };
}

function assertSlugsDefinedOnce(
  definitions: readonly FeatureFlagDefinition[],
): void {
  const seen = new Set<string>();
  for (const { slug } of definitions) {
    if (seen.has(slug)) {
      throw new Error(`Feature flag ${slug} is defined more than once`);
    }
    seen.add(slug);
  }
}

function publicDefinitions(
  definitions: readonly FeatureFlagDefinition[],
  publicSlugs: readonly string[],
): readonly FeatureFlagDefinition[] {
  const bySlug = new Map(
    definitions.map((definition) => [definition.slug, definition]),
  );
  return publicSlugs.map((slug) => {
    const definition = bySlug.get(slug);
    if (definition === undefined) {
      throw new Error(`Public feature flag ${slug} is not defined`);
    }
    return definition;
  });
}
