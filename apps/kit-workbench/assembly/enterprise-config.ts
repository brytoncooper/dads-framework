import type { EnterpriseSsoProvider } from "@dads-framework/identity-better-auth";
import { tenantIdSchema } from "@dads-framework/tenants";
import { z } from "zod";

import {
  staffImpersonationConfiguration,
  type StaffImpersonationConfiguration,
} from "../domains/support/index.js";

const provider = z.strictObject({
  id: z.string(),
  tenantId: tenantIdSchema.transform((id) => id.toLowerCase()),
  domain: z.string(),
  mode: z.enum(["optional", "required"]),
});
const providers = z
  .array(
    z.discriminatedUnion("protocol", [
      provider.extend({
        protocol: z.literal("oidc"),
        issuer: z.url(),
        clientId: z.string(),
        clientSecret: z.string(),
        authorizationEndpoint: z.url(),
        tokenEndpoint: z.url(),
        jwksEndpoint: z.url(),
        tokenEndpointAuthentication: z
          .enum(["client_secret_basic", "client_secret_post"])
          .optional(),
      }),
      provider.extend({
        protocol: z.literal("saml"),
        entityId: z.string(),
        signInUrl: z.url(),
        signingCertificate: z.string(),
        emailAttribute: z.string().optional(),
      }),
    ]),
  )
  .min(1);
const scim = z.strictObject({
  tenantId: tenantIdSchema,
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type ScimConfiguration = z.output<typeof scim>;

export type EnterpriseConfiguration = {
  readonly ssoProviders?: readonly EnterpriseSsoProvider[];
  readonly scim?: readonly ScimConfiguration[];
  readonly staffImpersonation?: StaffImpersonationConfiguration;
};

export function readEnterpriseConfiguration(
  source: NodeJS.ProcessEnv,
): EnterpriseConfiguration {
  const ssoProviders = readSetting(
    source,
    "DADS_ENTERPRISE_SSO_PROVIDERS",
    providers,
  )?.map((entry): EnterpriseSsoProvider => {
    if (entry.protocol === "oidc") {
      const { tokenEndpointAuthentication, ...config } = entry;
      return {
        ...config,
        ...(tokenEndpointAuthentication === undefined
          ? {}
          : { tokenEndpointAuthentication }),
      };
    }
    const { emailAttribute, ...config } = entry;
    return {
      ...config,
      ...(emailAttribute === undefined ? {} : { emailAttribute }),
    };
  });
  const scimConfig = readSetting(
    source,
    "DADS_ENTERPRISE_SCIM",
    z.array(scim).min(1),
  );
  const staffImpersonation = readSetting(
    source,
    "DADS_ENTERPRISE_STAFF_IMPERSONATION",
    staffImpersonationConfiguration,
  );
  return {
    ...(staffImpersonation === undefined ? {} : { staffImpersonation }),
    ...(ssoProviders === undefined ? {} : { ssoProviders }),
    ...(scimConfig === undefined ? {} : { scim: scimConfig }),
  };
}

function readSetting<Value>(
  source: NodeJS.ProcessEnv,
  key: string,
  schema: z.ZodType<Value>,
): Value | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // JSON syntax errors can contain fragments of the input.
  }
  throw new Error(`Invalid ${key} configuration.`);
}
