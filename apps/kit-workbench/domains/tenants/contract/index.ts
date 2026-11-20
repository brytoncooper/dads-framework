import { tenantIdSchema } from "@dads-framework/tenants";
import { z } from "zod";

export * from "./wire.js";

export const tenantInvitationParams = z.strictObject({
  tenantId: tenantIdSchema,
});
