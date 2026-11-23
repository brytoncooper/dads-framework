import { toCsv } from "@dads-framework/documents/csv";
import { notFound } from "@dads-framework/core/errors";
import { getRoute, routeGroup } from "@dads-framework/http";
import { createPdfRenderer } from "@dads-framework/documents/pdf";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { StarterServices } from "../../../libraries/app-runtime/index.js";
import { notesAccess } from "../access/index.js";
import { inTenant } from "../contract/index.js";
import { notesExportFlag } from "./flags.js";
import { noteTable } from "./tables.js";

const exportPath = inTenant.extend({
  noteId: z.uuid(),
  format: z.enum(["csv", "pdf"]),
});

export function noteExportRoutes({
  db,
  flags,
}: Pick<StarterServices, "db" | "flags">) {
  const pdf = createPdfRenderer();
  return routeGroup("Notes", [
    getRoute({
      route: {
        method: "GET",
        template: "/tenants/:tenantId/notes/:noteId/exports/:format",
      },
      summary: "Generate a CSV or PDF copy of a note",
      access: notesAccess,
      params: exportPath,
      response: z.strictObject({ contentType: z.string(), base64: z.base64() }),
      handler: async ({ params }) => {
        const state = await flags.execute({
          kind: "tenant",
          tenantId: params.tenantId,
        });
        if (!state.features.includes(notesExportFlag.slug))
          throw notFound("NOT_FOUND", "Note export not available");
        const [note] = await db
          .select({ text: noteTable.text })
          .from(noteTable)
          .where(
            and(
              eq(noteTable.id, params.noteId),
              eq(noteTable.tenantId, params.tenantId),
            ),
          )
          .limit(1);
        if (!note) throw notFound("NOT_FOUND", "Note not found");
        return params.format === "csv"
          ? csvExport(note.text)
          : {
              contentType: "application/pdf",
              base64: Buffer.from(
                await pdf.render({ content: ["Note", note.text] }),
              ).toString("base64"),
            };
      },
    }),
  ]);
}

function csvExport(text: string) {
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  const csv = toCsv([{ text: safeText }], [{ key: "text", header: "Note" }]);
  return {
    contentType: "text/csv",
    base64: Buffer.from(csv).toString("base64"),
  };
}
