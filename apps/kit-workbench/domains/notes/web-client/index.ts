import {
  getFromApi,
  getPageFromApi,
  sendToApi,
} from "@dads-framework/client-request-transport";
import { defineRoute, paginationQuerySchema } from "@dads-framework/contract";
import { z } from "zod";
import { note, noteInput, noteFeatures } from "../contract/wire.js";

export type Note = z.output<typeof note>;

const collectionPath = "/tenants/:tenantId/notes";
function tenantNotes(tenantId: string) {
  return `/tenants/${encodeURIComponent(tenantId)}/notes`;
}
const list = defineRoute("GET", collectionPath, tenantNotes);
const create = defineRoute("POST", collectionPath, tenantNotes);
const features = defineRoute(
  "GET",
  "/tenants/:tenantId/notes/features",
  (tenantId: string) => `${tenantNotes(tenantId)}/features`,
);

export function listNotes(tenantId: string, page: number, signal: AbortSignal) {
  return getPageFromApi({
    route: list.bind(tenantId),
    returns: note,
    query: { schema: paginationQuerySchema, value: { page, perPage: 12 } },
    signal,
  });
}

export function readFeatures(tenantId: string, signal: AbortSignal) {
  return getFromApi({
    route: features.bind(tenantId),
    returns: noteFeatures,
    signal,
  });
}

export function createNote(tenantId: string, text: string) {
  return sendToApi({
    route: create.bind(tenantId),
    body: { schema: noteInput, value: { text } },
    returns: note,
  });
}

export { notesExport } from "../contract/wire.js";

export type NoteExportFormat = "csv" | "pdf";

const exportRoute = defineRoute(
  "GET",
  "/tenants/:tenantId/notes/:noteId/exports/:format",
  (tenantId: string, noteId: string, format: NoteExportFormat) =>
    `${tenantNotes(tenantId)}/${encodeURIComponent(noteId)}/exports/${format}`,
);

export function exportNote(
  tenantId: string,
  noteId: string,
  format: NoteExportFormat,
) {
  return getFromApi({
    route: exportRoute.bind(tenantId, noteId, format),
    returns: z.object({
      contentType: z.enum(["application/pdf", "text/csv"]),
      base64: z.base64(),
    }),
  });
}
