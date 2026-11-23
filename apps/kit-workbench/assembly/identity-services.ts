import {
  createBetterAuthIdentity,
  createEnterpriseBetterAuthIdentity,
  type BetterAuthIdentityOptions,
} from "@dads-framework/identity/better-auth";
import { createTenantDirectory, type TenantsOptions } from "@dads-framework/identity/tenants";

import type { EnterpriseConfiguration } from "./enterprise-config.js";
import { configureScim } from "./scim.js";

export async function openIdentityServices(
  identityOptions: BetterAuthIdentityOptions,
  enterprise: EnterpriseConfiguration | undefined,
  tenantOptions: TenantsOptions,
) {
  const providers = enterprise?.ssoProviders?.map((provider) => ({
    ...provider,
    tenantId: provider.tenantId.toLowerCase(),
  }));
  const scim = enterprise?.scim;
  const tenantIds = new Set(providers?.map(({ tenantId }) => tenantId));
  for (const { tenantId } of scim ?? []) tenantIds.add(tenantId.toLowerCase());
  if (tenantIds.size > 0) {
    const existing = await createTenantDirectory(tenantOptions.database).findActiveTenants([...tenantIds]);
    if (existing.length !== tenantIds.size) throw new Error("Configure enterprise identity for existing tenants.");
  }
  const enterpriseIdentity =
    providers === undefined ? undefined : await createEnterpriseBetterAuthIdentity(identityOptions, providers);
  return {
    identity: enterpriseIdentity ?? createBetterAuthIdentity(identityOptions),
    enterpriseIdentity,
    ...(enterpriseIdentity === undefined
      ? {}
      : {
          readTenantSessionPolicy: enterpriseIdentity.readTenantSessionPolicy,
        }),
    scimHandler: scim === undefined ? undefined : configureScim(identityOptions.baseUrl, scim, tenantOptions),
  };
}
