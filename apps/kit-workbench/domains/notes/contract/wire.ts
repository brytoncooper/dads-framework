import { z } from "zod";

export const noteInput = z.object({ text: z.string().trim().min(1).max(2000) });
export const note = noteInput.extend({
  id: z.uuid(),
  tenantId: z.uuid(),
});

export const notesExport = "notes.export";

export const noteFeatures = z.object({
  features: z.array(z.string()),
  stateHash: z.string(),
});
