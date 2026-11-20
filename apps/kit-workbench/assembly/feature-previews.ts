import { createHash, timingSafeEqual } from "node:crypto";
import type { Authorization } from "@dads-framework/access/runtime";
import {
  CLIENT_FEATURE_STATE_HASH_HEADER,
  FEATURE_STATE_CONTEXT_HEADER,
  FEATURE_STATE_HASH_HEADER,
  featureFlagSlugSchema,
  type FeatureFlagDefinition,
  type GetEffectiveFeatureState,
} from "@dads-framework/feature-flags";
import {
  createFeatureFlagPreviewResolver,
  type FeatureFlagContextResolver,
  type FeatureFlagPreviewRecord,
  FeatureFlagRequestEvaluator,
} from "@dads-framework/feature-flags-http";
import type { FeatureStateProtocol } from "@dads-framework/http";
import { tenantIdSchema } from "@dads-framework/tenants";
import { z } from "zod";

import { accountEntity, tenantAccess } from "../libraries/app-runtime/index.js";
import { tenantFromRequest } from "./session-subjects.js";

const previewSetting = z.strictObject({
  accountId: accountEntity.idSchema,
  tenantId: tenantIdSchema.transform((id) => id.toLowerCase()),
  feature: featureFlagSlugSchema,
  active: z.boolean(),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.iso.datetime().transform((value) => new Date(value)),
});

export type FeaturePreviewConfiguration = z.output<typeof previewSetting>;

export function readFeaturePreview(
  environment: NodeJS.ProcessEnv,
): FeaturePreviewConfiguration | undefined {
  const raw = environment["DADS_FEATURE_PREVIEW"];
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = previewSetting.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // JSON syntax errors can contain fragments of the input.
  }
  throw new Error("Invalid DADS_FEATURE_PREVIEW configuration.");
}

const resolveTenant: FeatureFlagContextResolver = ({ context }) => {
  const tenant = tenantIdSchema.safeParse(context);
  return tenant.success ? { kind: "tenant", tenantId: tenant.data } : null;
};

export function configureFeaturePreviews(options: {
  readonly configuration: FeaturePreviewConfiguration;
  readonly definitions: readonly FeatureFlagDefinition[];
  readonly flags: GetEffectiveFeatureState;
  readonly authorization: Authorization;
}): FeatureStateProtocol {
  const { configuration, definitions, flags, authorization } = options;
  if (!definitions.some(({ slug }) => slug === configuration.feature)) {
    throw new Error("Configure feature previews for a defined customer flag.");
  }
  const record: FeatureFlagPreviewRecord = {
    owner: { type: accountEntity.wireName, id: configuration.accountId },
    context: { kind: "tenant", tenantId: configuration.tenantId },
    feature: configuration.feature,
    active: configuration.active,
    allowsWrites: false,
    expiresAt: configuration.expiresAt,
  };
  const view = tenantAccess.tenant.permissions.view;
  const expectedDigest = Buffer.from(configuration.tokenSha256, "hex");
  return {
    evaluator: new FeatureFlagRequestEvaluator(flags, resolveTenant),
    contextHeader: FEATURE_STATE_CONTEXT_HEADER,
    contextFromRequest: ({ url }) => tenantFromRequest(url),
    hashHeader: FEATURE_STATE_HASH_HEADER,
    clientHashHeader: CLIENT_FEATURE_STATE_HASH_HEADER,
    preview: {
      requestHeader: "x-feature-preview",
      droppedHeader: "x-feature-preview-dropped",
      resolver: createFeatureFlagPreviewResolver({
        definitions,
        resolveContext: resolveTenant,
        findPreview: (token) => {
          const digest = createHash("sha256").update(token).digest();
          return Promise.resolve(
            timingSafeEqual(digest, expectedDigest) ? record : null,
          );
        },
        canPreview: ({ subject, context }) =>
          context.kind === "tenant"
            ? authorization.check({
                subject,
                permission: view.permissionName,
                resource: { type: view.entityWireName, id: context.tenantId },
              })
            : Promise.resolve(false),
      }),
    },
  };
}
