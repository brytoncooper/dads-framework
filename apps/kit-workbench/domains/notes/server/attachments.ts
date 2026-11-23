import { createHash, randomUUID } from "node:crypto";
import { notFound } from "@dads-framework/core/errors";
import { getRoute, routeGroup, postRoute } from "@dads-framework/http";
import { defineJob } from "@dads-framework/job-queue/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { StarterServices } from "../../../libraries/app-runtime/index.js";
import { notesAccess, notesPermission } from "../access/index.js";
import { inTenant, noteIdSchema } from "../contract/index.js";
import { noteTable } from "./tables.js";

type Files = Pick<StarterServices, "files" | "jobs" | "writeWithPermission">;
const attachmentJobName = "notes.inspect-attachment";
const notePath = inTenant.extend({ noteId: noteIdSchema });
const filePath = notePath.extend({ fileId: z.uuid() });
const digest = z.strictObject({
  bytes: z.number().int(),
  sha256: z.string().length(64),
});

export function noteAttachmentJobs({ files }: Pick<StarterServices, "files">) {
  return [
    defineJob({
      name: attachmentJobName,
      payload: filePath,
      retry: { attempts: 3, backoffMs: 300 },
      schedules: [],
      run: async (params) => {
        const key = objectKey(params);
        const stored = await files.get(key);
        if (!stored) return;
        const facts = {
          bytes: stored.body.byteLength,
          sha256: createHash("sha256").update(stored.body).digest("hex"),
        };
        await files.put(`${key}.facts`, JSON.stringify(facts), "application/json");
      },
    }),
  ];
}

export function noteAttachmentRoutes(services: Files) {
  return routeGroup("Notes", [
    postRoute({
      route: {
        method: "POST",
        template: "/tenants/:tenantId/notes/:noteId/attachments",
      },
      summary: "Attach a short UTF-8 text file to a note",
      access: notesAccess,
      params: notePath,
      body: z.strictObject({ text: z.string().min(1).max(16_384) }),
      response: z.strictObject({ fileId: z.uuid() }),
      handler: ({ body, params, subject }) => storeNoteAttachment(services, params, subject, body.text),
    }),
    getRoute({
      route: {
        method: "GET",
        template: "/tenants/:tenantId/notes/:noteId/attachments/:fileId",
      },
      summary: "Read a note attachment and its inspected byte digest",
      access: notesAccess,
      params: filePath,
      response: z.strictObject({
        text: z.string(),
        inspection: digest.nullable(),
      }),
      handler: ({ params }) => readNoteAttachment(services, params),
    }),
  ]);
}

async function storeNoteAttachment(
  { files, jobs, writeWithPermission }: Files,
  params: z.infer<typeof notePath>,
  subject: Parameters<StarterServices["writeWithPermission"]>[0]["subject"],
  text: string,
) {
  const fileId = randomUUID();
  const uploaded = { ...params, fileId };
  const key = objectKey(uploaded);
  try {
    await writeWithPermission({ subject, permission: notesPermission, resourceId: params.tenantId }, async (tx) => {
      const [note] = await tx
        .select({ id: noteTable.id })
        .from(noteTable)
        .where(and(eq(noteTable.id, params.noteId), eq(noteTable.tenantId, params.tenantId)))
        .limit(1);
      if (!note) throw notFound("NOT_FOUND", "Note not found");
      await files.put(key, text, "text/plain");
    });
  } catch (error) {
    await files.delete(key).catch(() => undefined);
    throw error;
  }
  await jobs.enqueue(attachmentJobName, uploaded);
  return { fileId };
}

async function readNoteAttachment({ files }: Files, params: z.infer<typeof filePath>) {
  const key = objectKey(params);
  const [stored, inspected] = await Promise.all([files.get(key), files.get(`${key}.facts`)]);
  if (!stored) throw notFound("NOT_FOUND", "Attachment not found");
  const decode = new TextDecoder();
  return {
    text: decode.decode(stored.body),
    inspection: inspected ? digest.parse(JSON.parse(decode.decode(inspected.body))) : null,
  };
}

function objectKey({ tenantId, noteId, fileId }: z.infer<typeof filePath>): string {
  return `notes/${tenantId}/${noteId}/${fileId}`;
}
