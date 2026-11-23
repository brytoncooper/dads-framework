import { getFromApi, sendToApi } from "@dads-framework/client";
import { defineRoute } from "@dads-framework/core/contract";
import { z } from "zod";
import type { NoteId } from "../../domains/notes/web-client/index.js";

const attachmentUploadBody = z.strictObject({
  text: z.string().min(1).max(16_384),
});

const attachmentUploaded = z.strictObject({
  fileId: z.uuid(),
});

const attachmentInspection = z.strictObject({
  bytes: z.number().int(),
  sha256: z.string().length(64),
});

const attachmentRecord = z.strictObject({
  text: z.string(),
  inspection: attachmentInspection.nullable(),
});

export type NoteAttachmentInspection = z.output<typeof attachmentInspection>;
export type NoteAttachmentRecord = z.output<typeof attachmentRecord>;

function attachmentCollectionPath(tenantId: string, noteId: NoteId): string {
  return `/tenants/${encodeURIComponent(tenantId)}/notes/${encodeURIComponent(noteId)}/attachments`;
}

const uploadRoute = defineRoute("POST", "/tenants/:tenantId/notes/:noteId/attachments", attachmentCollectionPath);

const readRoute = defineRoute(
  "GET",
  "/tenants/:tenantId/notes/:noteId/attachments/:fileId",
  (tenantId: string, noteId: NoteId, fileId: string) =>
    `${attachmentCollectionPath(tenantId, noteId)}/${encodeURIComponent(fileId)}`,
);

export function uploadNoteAttachment(tenantId: string, noteId: NoteId, text: string) {
  return sendToApi({
    route: uploadRoute.bind(tenantId, noteId),
    body: { schema: attachmentUploadBody, value: { text } },
    returns: attachmentUploaded,
  });
}

export function readNoteAttachment(tenantId: string, noteId: NoteId, fileId: string, signal?: AbortSignal) {
  return getFromApi({
    route: readRoute.bind(tenantId, noteId, fileId),
    returns: attachmentRecord,
    ...(signal === undefined ? {} : { signal }),
  });
}
