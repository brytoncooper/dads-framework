import {
  resource,
  type DslActor,
  type RoleToken,
} from "@dads-framework/access";
import { z } from "zod";

export const tenantIdSchema = z.uuid().brand<"TenantId">();
export type TenantId = z.output<typeof tenantIdSchema>;

export const tenantRoles = ["owner", "admin", "member"] as const;
export type TenantRole = (typeof tenantRoles)[number];
export const assignableTenantRoleSchema = z
  .enum(tenantRoles)
  .exclude(["owner"]);

export function createTenantAccess<WireName extends string = string>(
  account: DslActor<WireName>,
) {
  const tenant = resource("tenants/tenant", {
    id: tenantIdSchema,
    roles: { owner: account, admin: account, member: account } satisfies Record<
      TenantRole,
      DslActor<WireName>
    >,
    can: ({ owner, admin, member }) => ({
      view: [owner, admin, member],
      manage_members: [owner, admin],
      manage_tenant: owner,
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
