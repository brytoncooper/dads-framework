import { tenantIdSchema } from "@dads-framework/identity/tenants";
import { z } from "zod";

export * from "./wire.js";

export const inTenant = z.object({ tenantId: tenantIdSchema });
