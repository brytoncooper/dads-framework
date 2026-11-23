import { fromParam, requires } from "@dads-framework/http";
import { tenantAccess } from "../../../libraries/app-runtime/index.js";
import { noteIdSchema } from "../contract/wire.js";

/** Notes inherit visibility from their parent tenant and require a branded NoteId. */
export const note = tenantAccess.tenant.child("note", {
  id: noteIdSchema,
  inherit: ["view"],
});

export const notesPermission = tenantAccess.tenant.permissions.view;

/** Notes are visible only inside a tenant the account can view. */
export const notesAccess = requires(notesPermission, fromParam("tenantId"));
