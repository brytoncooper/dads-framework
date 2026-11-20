import { z } from "zod";

import { featureFlagSlugSchema } from "./feature-flag-definition.schema.js";

/** Default header names; an application may pick its own and hand them to the HTTP kit. */
export const FEATURE_STATE_HASH_HEADER = "x-feature-state-hash";
export const CLIENT_FEATURE_STATE_HASH_HEADER = "x-client-feature-state-hash";
export const FEATURE_STATE_CONTEXT_HEADER = "x-feature-state-context";

/** Route paths the HTTP binding serves and a client calls. */
export const FEATURE_FLAGS_PATH = "/feature-flags";
export const FEATURE_FLAG_HISTORY_PATH = "/feature-flags/:slug/history";
export const FEATURE_STATE_PATH = "/feature-state";
export const PUBLIC_FEATURE_STATE_PATH = "/feature-state/public";

export const featureStateHashSchema = z.string().trim().min(1).meta({
  description: "Opaque hash of the effective, sorted feature allow-list",
});

export const effectiveFeatureStateSchema = z
  .strictObject({
    features: z.array(featureFlagSlugSchema).meta({
      description: "Effective feature allow-list; omitted slugs are inactive",
    }),
    stateHash: featureStateHashSchema,
  })
  .readonly();
export type EffectiveFeatureState = z.infer<typeof effectiveFeatureStateSchema>;

/**
 * What a signed-out reader may see: flags from the application's declared
 * public list that are on for everyone. No tenant pilot, no hash.
 */
export const publicFeatureStateSchema = z
  .strictObject({
    features: z.array(featureFlagSlugSchema).meta({
      description:
        "Public-list flags that are on for everyone; an omitted slug is off or not public",
    }),
  })
  .readonly();
export type PublicFeatureState = z.infer<typeof publicFeatureStateSchema>;
