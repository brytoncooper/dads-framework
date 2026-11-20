import { z } from "zod";

import {
  entityIdSchema,
  paginationQuerySchema,
} from "@dads-framework/contract";

import {
  featureFlagAudienceModeSchema,
  featureFlagDefinitionSchema,
  featureFlagSlugSchema,
} from "./feature-flag-definition.schema.js";

/** The application's tenant key. The package stores and compares it; it never parses it. */
export const tenantIdSchema = z.string().trim().min(1).meta({
  description: "Application-defined tenant key",
});

/** Who changed a flag: the authenticated subject's id, as the application issues it. */
export const featureFlagActorIdSchema = z.string().trim().min(1).meta({
  description: "Id of the subject that changed the flag",
});

/** One management batch; every history entry it wrote carries it. */
export const featureFlagBatchIdSchema = entityIdSchema(
  "FeatureFlagBatchId",
  "Atomic feature-flag management batch id",
);
export type FeatureFlagBatchId = z.infer<typeof featureFlagBatchIdSchema>;

export const featureFlagRevisionSchema = z.number().int().nonnegative().meta({
  description: "Monotonic revision for atomic feature-flag management writes",
});

export const featureFlagRememberedTenantSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    tenantName: z.string().trim().min(1).meta({
      description: "Tenant name for management display",
    }),
    enabledAt: z.iso.datetime().nullable().meta({
      description:
        "Time this tenant was last selected, ISO 8601 UTC; null while it is not selected",
    }),
  })
  .readonly();
export type FeatureFlagRememberedTenant = z.infer<
  typeof featureFlagRememberedTenantSchema
>;

/**
 * Durable flag state. A flag with no stored row reads as its default:
 * revision 0, OFF, and null timestamps.
 */
export const featureFlagStateSchema = z
  .strictObject({
    slug: featureFlagSlugSchema,
    audienceMode: featureFlagAudienceModeSchema,
    rememberedTenants: z.array(featureFlagRememberedTenantSchema).meta({
      description: "Pilot tenants kept across OFF and EVERYONE",
    }),
    revision: featureFlagRevisionSchema,
    globalEnabledAt: z.iso.datetime().nullable().meta({
      description: "Time EVERYONE was last turned on, ISO 8601 UTC",
    }),
    updatedAt: z.iso.datetime().nullable().meta({
      description: "Last durable state update time, ISO 8601 UTC",
    }),
    updatedBy: featureFlagActorIdSchema.nullable(),
  })
  .readonly();
export type FeatureFlagState = z.infer<typeof featureFlagStateSchema>;

export const featureFlagManagementListSchema = z
  .strictObject({
    flags: z.array(
      z
        .strictObject({
          definition: featureFlagDefinitionSchema,
          state: featureFlagStateSchema,
          cleanupReady: z.boolean().meta({
            description:
              "Whether this flag has been on for everyone long enough to remove",
          }),
        })
        .readonly(),
    ),
  })
  .readonly();
export type FeatureFlagManagementList = z.infer<
  typeof featureFlagManagementListSchema
>;

export const featureFlagHistoryEntrySchema = z
  .strictObject({
    batchId: featureFlagBatchIdSchema,
    slug: featureFlagSlugSchema,
    revision: featureFlagRevisionSchema,
    previousState: featureFlagStateSchema,
    nextState: featureFlagStateSchema,
    note: z.string().trim().min(1).optional().meta({
      description: "Optional operator note recorded for this revision",
    }),
    changedAt: z.iso
      .datetime()
      .meta({ description: "Change time, ISO 8601 UTC" }),
    changedBy: featureFlagActorIdSchema,
  })
  .readonly();
export type FeatureFlagHistoryEntry = z.infer<
  typeof featureFlagHistoryEntrySchema
>;

export const featureFlagHistoryParamsSchema = z
  .strictObject({ slug: featureFlagSlugSchema })
  .readonly();
export const featureFlagHistoryQuerySchema = paginationQuerySchema.strict();

const selectedTenantIdsSchema = z
  .array(tenantIdSchema)
  .min(1)
  .superRefine((tenantIds, context) => {
    if (new Set(tenantIds).size !== tenantIds.length) {
      context.addIssue({
        code: "custom",
        message: "Selected tenant ids must be unique.",
      });
    }
  });

const featureFlagUpdateBase = {
  slug: featureFlagSlugSchema,
  expectedRevision: featureFlagRevisionSchema,
  note: z.string().trim().min(1).optional().meta({
    description: "Optional operator note for this flag update",
  }),
};

export const updateFeatureFlagInputSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ ...featureFlagUpdateBase, mode: z.literal("OFF") }),
    z.strictObject({ ...featureFlagUpdateBase, mode: z.literal("EVERYONE") }),
    z.strictObject({
      ...featureFlagUpdateBase,
      mode: z.literal("SELECTED_TENANTS"),
      tenantIds: selectedTenantIdsSchema,
    }),
  ])
  .readonly();
export type UpdateFeatureFlagInput = z.infer<
  typeof updateFeatureFlagInputSchema
>;

export const updateFeatureFlagsRequestSchema = z
  .strictObject({
    changes: z.array(updateFeatureFlagInputSchema).min(1).meta({
      description: "Flag audience updates applied together or not at all",
    }),
  })
  .readonly();
export type UpdateFeatureFlagsRequest = z.infer<
  typeof updateFeatureFlagsRequestSchema
>;

export const updateFeatureFlagsResponseSchema = z
  .strictObject({ states: z.array(featureFlagStateSchema) })
  .readonly();
