import type { SubjectResolver } from "@dads-framework/http";
import type { Identity } from "@dads-framework/identity";
import type { EnterpriseBetterAuthIdentity } from "@dads-framework/identity-better-auth";
import { tenantIdSchema } from "@dads-framework/tenants";

import { accountEntity } from "../libraries/app-runtime/index.js";

export function sessionSubjects(
  identity: Identity,
  enterprise?: EnterpriseBetterAuthIdentity,
): SubjectResolver {
  return {
    async resolve({ headers, url }) {
      const normalized = new Headers();
      for (const [name, header] of Object.entries(headers)) {
        if (typeof header === "string") normalized.set(name, header);
      }
      const tenantId = tenantFromRequest(url);
      const session =
        enterprise !== undefined && tenantId !== undefined
          ? await enterprise.readTenantSession(normalized, tenantId)
          : await identity.readSession(normalized);
      return session === null
        ? null
        : { type: accountEntity.wireName, id: session.account.id };
    },
  };
}

export function tenantFromRequest(url?: string): string | undefined {
  const path = url?.split("?")[0];
  const match = /^\/api\/tenants\/([^/]+)(?:\/|$)/u.exec(path ?? "");
  const segment = match?.[1];
  if (segment === undefined) return undefined;
  try {
    const tenant = tenantIdSchema.safeParse(decodeURIComponent(segment));
    return tenant.success ? tenant.data.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
