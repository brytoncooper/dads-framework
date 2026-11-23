import { resource, type DslActor, type RoleToken } from "@dads-framework/access";
import { tenantIdSchema, type TenantRole } from "./contract.js";

export { assignableTenantRoleSchema, tenantIdSchema, tenantRoles, type TenantId, type TenantRole } from "./contract.js";

export function createTenantAccess<WireName extends string = string>(account: DslActor<WireName>) {
  const tenant = resource("tenants/tenant", {
    id: tenantIdSchema,
    roles: { owner: account, admin: account, member: account } satisfies Record<TenantRole, DslActor<WireName>>,
    can: ({ owner, admin, member }) => ({
      view: [owner, admin, member],
      manage_members: [owner, admin],
      manage_tenant: owner,
    }),
  });
  return { account, tenant };
}

export type TenantAccess = ReturnType<typeof createTenantAccess>;

export function tenantRoleToken(tenant: TenantAccess, role: TenantRole): RoleToken {
  return tenant.tenant.roles[role];
}
