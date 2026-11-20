import { defineRoute } from "@dads-framework/contract";
import { z } from "zod";

export const permissionAccountId = z.string().min(1);

export const permissionMember = z.strictObject({
  accountId: permissionAccountId,
  role: z.enum(["owner", "admin", "member"]),
});

export const memberPermissions = z.strictObject({
  role: permissionMember.shape.role,
  view: z.boolean(),
  manageMembers: z.boolean(),
  manageTenant: z.boolean(),
});

export const permissionRosterRoute = defineRoute(
  "GET",
  "/tenants/:tenantId/members",
  (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/members`,
);

export const memberPermissionsRoute = defineRoute(
  "GET",
  "/tenants/:tenantId/members/:accountId/permissions",
  (tenantId: string, accountId: string) =>
    `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(accountId)}/permissions`,
);
