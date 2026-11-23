import { createApiClient } from "@dads-framework/client";
import type { z } from "zod";
import {
  createNoteOp,
  exportNoteOp,
  listNotesOp,
  readNoteFeaturesOp,
  type note,
  type noteExportFormat,
  type NoteId,
} from "../contract/wire.js";

export type Note = z.output<typeof note>;
export type NoteExportFormat = z.output<typeof noteExportFormat>;
export type { NoteId } from "../contract/wire.js";
export { notesExport } from "../contract/wire.js";

export const notesClient = createApiClient({
  list: listNotesOp,
  readFeatures: readNoteFeaturesOp,
  create: createNoteOp,
  exportFile: exportNoteOp,
});

export function listNotes(tenantId: string, page: number, signal: AbortSignal) {
  return notesClient.list({
    params: { tenantId },
    query: { page, perPage: 12 },
    signal,
  });
}

export function readFeatures(tenantId: string, signal: AbortSignal) {
  return notesClient.readFeatures({
    params: { tenantId },
    signal,
  });
}

export function createNote(tenantId: string, text: string) {
  return notesClient.create({
    params: { tenantId },
    body: { text },
  });
}

export function exportNote(tenantId: string, noteId: NoteId, format: NoteExportFormat) {
  return notesClient.exportFile({
    params: { tenantId, noteId, format },
  });
}
