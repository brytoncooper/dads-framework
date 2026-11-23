import { tenantIdSchema } from "@dads-framework/identity/tenants";
import { z } from "zod";

const accountId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\0]+$/u);
export const staffImpersonationConfiguration = z.strictObject({
  tenantId: z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(tenantIdSchema),
  staffAccountIds: z.array(accountId).min(1),
  revokerAccountIds: z.array(accountId),
});

export type StaffImpersonationConfiguration = z.output<
  typeof staffImpersonationConfiguration
>;
