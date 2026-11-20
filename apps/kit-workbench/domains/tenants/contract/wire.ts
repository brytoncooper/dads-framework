import { z } from "zod";

const tenantWireId = z.uuid();

export const tenantInput = z.object({
  name: z.string().trim().min(1).max(120),
});
export const tenantRecord = tenantInput.extend({ id: tenantWireId });
export const tenantInvitationInput = z.strictObject({ email: z.email() });
export const tenantInvitationIssued = z.strictObject({
  expiresAt: z.iso.datetime(),
});
export const tenantInvitationAcceptance = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export const tenantInvitationAccepted = z.strictObject({
  tenantId: tenantWireId,
});
