import type { SubjectResolver } from "@dads-framework/http";
import type { Identity } from "@dads-framework/identity";
import type { EnterpriseBetterAuthIdentity } from "@dads-framework/identity-better-auth";
import { tenantIdSchema } from "@dads-framework/tenants";

import { account } from "../libraries/app-runtime/index.js";

export function sessionSubjects(
  identity: Identity,
  enterprise?: Pick<EnterpriseBetterAuthIdentity, "readTenantSession">,
): SubjectResolver {
  return {
    async resolve({ headers, params }) {
      const normalized = new Headers();
      for (const [name, header] of Object.entries(headers)) {
        if (typeof header === "string") normalized.set(name, header);
      }
      const tenantId = tenantFromParams(params);
      if (tenantId === null) return null;
      const session =
        enterprise !== undefined && tenantId !== undefined
          ? await enterprise.readTenantSession(normalized, tenantId)
          : await identity.readSession(normalized);
      return session === null
        ? null
        : { type: account.wireName, id: session.account.id };
    },
  };
}

/** Undefined is unscoped. Null means the matched tenant parameter is invalid. */
export function tenantFromParams(params: unknown): string | null | undefined {
  if (typeof params !== "object" || params === null || !("tenantId" in params))
    return undefined;
  const tenant = tenantIdSchema.safeParse(params.tenantId);
  return tenant.success ? tenant.data.toLowerCase() : null;
}
