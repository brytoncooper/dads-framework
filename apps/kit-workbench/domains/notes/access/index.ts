import { fromParam, type PermissionAccess } from "@dads-framework/http";
import { tenantAccess } from "../../../libraries/app-runtime/index.js";

export const notesPermission = tenantAccess.tenant.permissions.view;

/** Notes are visible only inside a tenant the account can view. */
export const notesAccess: PermissionAccess = {
  kind: "permission",
  resourceType: notesPermission.entityWireName,
  permission: notesPermission.permissionName,
  resourceId: fromParam("tenantId"),
};
