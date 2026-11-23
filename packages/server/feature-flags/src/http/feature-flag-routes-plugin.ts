import { featureFlagsService } from "../index.js";
import { definePlugin } from "@dads-framework/core/plugin";

import {
  createFeatureFlagRoutes,
  createPublicFeatureFlagRoutes,
  type FeatureFlagRoutesOptions,
} from "./feature-flag-routes.js";

export type FeatureFlagRoutesPluginOptions = Omit<FeatureFlagRoutesOptions, "featureFlags" | "manage"> &
  Partial<Pick<FeatureFlagRoutesOptions, "manage">>;

/** Add only public state unless the API host also supplies management access. */
export function createFeatureFlagRoutesPlugin(options: FeatureFlagRoutesPluginOptions = {}) {
  const { manage, tag } = options;
  return definePlugin({
    name: "feature-flag-routes",
    requires: [featureFlagsService],
    setup: ({ use }) => {
      const featureFlags = use(featureFlagsService);
      return {
        routes:
          manage === undefined
            ? createPublicFeatureFlagRoutes(featureFlags, tag)
            : createFeatureFlagRoutes({
                featureFlags,
                manage,
                ...(tag === undefined ? {} : { tag }),
              }),
      };
    },
  });
}
