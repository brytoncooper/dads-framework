import { fromParam, requires } from "@dads-framework/http";
import { tenantAccess } from "../../../libraries/app-runtime/index.js";

export const notesPermission = tenantAccess.tenant.permissions.view;

/** Notes are visible only inside a tenant the account can view. */
export const notesAccess = requires(notesPermission, fromParam("tenantId"));
