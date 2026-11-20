import { z } from "zod";

/**
 * Who sees a flag. `SELECTED_TENANTS` means the tenants the flag lists; what a
 * tenant is (a company, a team, a project) is the application's to say.
 */
export const FEATURE_FLAG_AUDIENCE_MODES = [
  "OFF",
  "SELECTED_TENANTS",
  "EVERYONE",
] as const;
export const featureFlagAudienceModeSchema = z.enum(
  FEATURE_FLAG_AUDIENCE_MODES,
);
export type FeatureFlagAudienceMode = z.infer<
  typeof featureFlagAudienceModeSchema
>;

export const featureFlagSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/)
  .meta({
    description:
      "Code-owned feature-flag slug: lowercase words and dashes, dot-separated (for example billing.invoices.bulk-export)",
  });

const featureFlagDefinitionShape = z.strictObject({
  slug: featureFlagSlugSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .meta({ description: "Human-readable flag name" }),
  description: z
    .string()
    .trim()
    .min(1)
    .meta({ description: "What this code-owned flag changes" }),
  owner: z.string().trim().min(1).meta({
    description: "Person or team accountable for rollout and cleanup",
  }),
  defaultEnabled: z.literal(false).meta({
    description: "Code-owned default; every new feature flag starts inactive",
  }),
  affectedPages: z.array(z.string().trim().min(1)).meta({
    description: "Pages this flag changes, as the application names them",
  }),
  affectedApiCapabilities: z.array(z.string().trim().min(1)).meta({
    description: "API capabilities this flag changes",
  }),
  cleanupTrigger: z.string().trim().min(1).meta({
    description:
      "Concrete condition that begins removal of this flag and its paths",
  }),
  globalStabilityDays: z.number().int().positive().meta({
    description:
      "Whole days the flag must stay on for everyone before cleanup is due",
  }),
});

/** A flag that changes nothing cannot be reviewed, rolled out or cleaned up. */
export const featureFlagDefinitionSchema = featureFlagDefinitionShape
  .superRefine((definition, context) => {
    if (
      definition.affectedPages.length === 0 &&
      definition.affectedApiCapabilities.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A feature flag must affect at least one page or API capability.",
        path: ["affectedPages"],
      });
    }
  })
  .readonly();
export type FeatureFlagDefinition = z.infer<typeof featureFlagDefinitionSchema>;

/** Parses a code-owned definition where it is declared, before anything can compose it. */
export function defineFeatureFlag(
  definition: FeatureFlagDefinition,
): FeatureFlagDefinition {
  return featureFlagDefinitionSchema.parse(definition);
}
