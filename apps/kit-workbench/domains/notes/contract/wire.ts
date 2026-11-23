import { getOperation, listOperation, paginationQuerySchema, postOperation } from "@dads-framework/core/contract";
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

export const noteExportFormat = z.enum(["csv", "pdf"]);
export const noteExportFile = z.strictObject({
  contentType: z.enum(["application/pdf", "text/csv"]),
  base64: z.base64(),
});

const tenantPathParams = z.object({ tenantId: z.uuid() });
const noteExportParams = tenantPathParams.extend({
  noteId: z.uuid(),
  format: noteExportFormat,
});

export const readNoteFeaturesOp = getOperation({
  path: "/tenants/:tenantId/notes/features",
  params: tenantPathParams,
  response: noteFeatures,
});

export const listNotesOp = listOperation({
  path: "/tenants/:tenantId/notes",
  params: tenantPathParams,
  query: paginationQuerySchema,
  item: note,
});

export const createNoteOp = postOperation({
  path: "/tenants/:tenantId/notes",
  params: tenantPathParams,
  body: noteInput,
  response: note,
});

export const exportNoteOp = getOperation({
  path: "/tenants/:tenantId/notes/:noteId/exports/:format",
  params: noteExportParams,
  response: noteExportFile,
});
