import { tenantIdSchema } from "@dads-framework/identity/tenants";
import { z } from "zod";

import { permissionAccountId } from "./permissions-wire.js";

export const scimBindingPath = "/tenants/:tenantId/scim/users/:scimUserId/bind";

export const scimBindingParams = z.object({
  tenantId: tenantIdSchema,
  scimUserId: z.uuid().refine((id) => id === id.toLowerCase()),
});

export const scimBindingInput = z.strictObject({
  accountId: permissionAccountId,
});
