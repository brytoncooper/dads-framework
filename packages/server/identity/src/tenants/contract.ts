import { z } from "zod";

export const tenantIdSchema = z.uuid().brand<"TenantId">();
export type TenantId = z.output<typeof tenantIdSchema>;

export const tenantRoles = ["owner", "admin", "member"] as const;
export type TenantRole = (typeof tenantRoles)[number];
export const assignableTenantRoleSchema = z.enum(tenantRoles).exclude(["owner"]);
