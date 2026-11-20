import {
  access,
  entityHandle,
  type EntityHandle,
  type RoleToken,
} from "@dads-framework/access";
import { z } from "zod";

export const tenantIdSchema = z.uuid().brand<"TenantId">();
export type TenantId = z.output<typeof tenantIdSchema>;

export const tenantEntity = entityHandle({
  wireName: "tenants/tenant",
  idSchema: tenantIdSchema,
  kind: "scope",
});

export const tenantRoles = ["owner", "admin", "member"] as const;
export type TenantRole = (typeof tenantRoles)[number];
export const assignableTenantRoleSchema = z
  .enum(tenantRoles)
  .exclude(["owner"]);

export function createTenantAccess(account: EntityHandle) {
  const tenant = access(tenantEntity, {
    roles: { owner: account, admin: account, member: account } satisfies Record<
      TenantRole,
      EntityHandle
    >,
    permissions: (roles) => ({
      view: [roles.owner, roles.admin, roles.member],
      manage_members: [roles.owner, roles.admin],
      manage_tenant: [roles.owner],
    }),
  });
  return { account, tenant };
}

export type TenantAccess = ReturnType<typeof createTenantAccess>;

export function tenantRoleToken(
  tenant: TenantAccess,
  role: TenantRole,
): RoleToken {
  return tenant.tenant.roles[role];
}
