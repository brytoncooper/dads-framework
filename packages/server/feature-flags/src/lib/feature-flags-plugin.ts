import { definePlugin, defineService } from "@dads-framework/plugin";

import type { FeatureFlagDefinition } from "../contract/index.js";

import {
  composeFeatureFlags,
  type FeatureFlags,
  type FeatureFlagsDeps,
} from "./compose-feature-flags.js";

type DefinitionOptions = Pick<FeatureFlagsDeps, "definitions" | "publicSlugs">;

export const featureFlagDepsService = defineService(
  "feature-flag-dependencies",
).ofType<Omit<FeatureFlagsDeps, keyof DefinitionOptions>>();

export const featureFlagsService =
  defineService("feature-flags").ofType<FeatureFlags>();

/** Declare this API's flags and connect them to the store chosen by its host. */
export function createFeatureFlagsPlugin(options: DefinitionOptions) {
  const definitions = [...options.definitions];
  const publicSlugs = [...(options.publicSlugs ?? [])];
  return definePlugin<
    "feature-flags",
    readonly [typeof featureFlagDepsService],
    FeatureFlags,
    never,
    never,
    FeatureFlagDefinition,
    "feature-flags"
  >({
    name: "feature-flags",
    requires: [featureFlagDepsService],
    implements: featureFlagsService,
    contributes: { flags: definitions },
    setup: ({ use }) => ({
      provides: composeFeatureFlags({
        ...use(featureFlagDepsService),
        definitions,
        publicSlugs,
      }),
    }),
  });
}
