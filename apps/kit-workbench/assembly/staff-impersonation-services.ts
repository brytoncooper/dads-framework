import type { Identity } from "@dads-framework/identity";
import {
  createImpersonation,
  type ImpersonationOptions,
} from "@dads-framework/identity/impersonation";
import type { EnterpriseBetterAuthIdentity } from "@dads-framework/identity/better-auth";
import { createPostgresImpersonationStore } from "@dads-framework/identity/better-auth/impersonation-store";
import type { createPostgresConnection } from "@dads-framework/postgres";
import type { Tenants } from "@dads-framework/identity/tenants";

import {
  configureStaffImpersonation,
  readTenantAsTarget,
  staffImpersonationConfiguration,
  type StaffImpersonationConfiguration,
} from "../domains/support/index.js";
import type { ServiceConfiguration } from "./services.js";

export type StaffImpersonationServices = {
  readonly staffImpersonation:
    ReturnType<typeof configureStaffImpersonation> | undefined;
};

export function openStaffImpersonationServices(
  pool: ReturnType<typeof createPostgresConnection>["pool"],
  config: ServiceConfiguration,
  {
    identity,
    enterpriseIdentity,
  }: {
    readonly identity: Identity;
    readonly enterpriseIdentity: EnterpriseBetterAuthIdentity | undefined;
  },
  tenants: Tenants,
): StaffImpersonationServices {
  if (config.enterprise?.staffImpersonation === undefined)
    return { staffImpersonation: undefined };
  const configuration = staffImpersonationConfiguration.parse(
    config.enterprise.staffImpersonation,
  );
  const { tenantId } = configuration;
  const persistence = createPostgresImpersonationStore(pool);
  const impersonation = createImpersonation({
    ...persistence,
    store: {
      ...persistence.store,
      async read(id) {
        const stored = await persistence.store.read(id);
        return stored?.tenantId === tenantId ? stored : null;
      },
    },
    identity:
      enterpriseIdentity === undefined
        ? identity
        : {
            readSession: (headers) =>
              enterpriseIdentity.readTenantSession(headers, tenantId),
          },
    lifetimeMs: 5 * 60 * 1000,
    authorize: staffSupportPolicy(configuration, tenants),
  });
  return {
    staffImpersonation: configureStaffImpersonation({
      baseUrl: config.baseUrl,
      tenantId,
      impersonation,
      tenants,
    }),
  };
}

function staffSupportPolicy(
  {
    tenantId,
    staffAccountIds,
    revokerAccountIds,
  }: StaffImpersonationConfiguration,
  tenants: Tenants,
): ImpersonationOptions["authorize"] {
  const staff = new Set(staffAccountIds);
  const revokers = new Set(revokerAccountIds);
  return async (scope) => {
    if (scope.tenantId !== tenantId) return false;
    if (scope.action === "revoke") return revokers.has(scope.actorAccountId);
    if (!staff.has(scope.actorAccountId)) return false;
    return (
      (await readTenantAsTarget(
        tenants,
        scope.effectiveAccountId,
        tenantId,
      )) !== null
    );
  };
}
