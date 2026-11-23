import { createHash, timingSafeEqual } from "node:crypto";
import { createScimHandler } from "@dads-framework/identity/scim";
import {
  createTenantScimDirectory,
  createTenantScimGroupDirectory,
  tenantIdSchema,
  type TenantsOptions,
} from "@dads-framework/identity/tenants";

import type { ScimConfiguration } from "./enterprise-config.js";

export function configureScim(baseUrl: string, configs: readonly ScimConfiguration[], tenants: TenantsOptions) {
  if (configs.length === 0) throw new Error("Configure at least one SCIM credential.");
  const digests = new Set<string>();
  const credentials = configs.map(({ tokenSha256, tenantId }) => {
    if (!/^[a-f0-9]{64}$/u.test(tokenSha256)) throw new Error("SCIM requires a SHA-256 bearer credential digest.");
    if (digests.has(tokenSha256)) throw new Error("SCIM credential digests must be unique.");
    digests.add(tokenSha256);
    return {
      digest: Buffer.from(tokenSha256, "hex"),
      tenantId: tenantIdSchema.parse(tenantId.toLowerCase()),
    };
  });
  return createScimHandler({
    baseUrl: new URL("/scim/v2", baseUrl).href,
    directory: createTenantScimDirectory(tenants),
    groups: createTenantScimGroupDirectory(tenants),
    authenticate: (token) => {
      const actual = createHash("sha256").update(token).digest();
      let tenantId: string | null = null;
      for (const credential of credentials) {
        if (timingSafeEqual(actual, credential.digest)) tenantId = credential.tenantId;
      }
      return Promise.resolve(tenantId);
    },
  });
}
