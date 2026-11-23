import { toCsv } from "@dads-framework/documents/csv";
import { notFound } from "@dads-framework/core/errors";
import { getRoute, routeGroup } from "@dads-framework/http";
import { createPdfRenderer } from "@dads-framework/documents/pdf";
import { and, eq } from "drizzle-orm";

import type { StarterServices } from "../../../libraries/app-runtime/index.js";
import { notesAccess } from "../access/index.js";
import { exportNoteOp } from "../contract/index.js";
import { escapeCsvFormulaCell } from "../pure/note-rules.js";
import { notesExportFlag } from "./flags.js";
import { noteTable } from "./tables.js";

export function noteExportRoutes({ db, flags }: Pick<StarterServices, "db" | "flags">) {
  const pdf = createPdfRenderer();
  return routeGroup("Notes", [
    getRoute({
      operation: exportNoteOp,
      summary: "Generate a CSV or PDF copy of a note",
      access: notesAccess,
      handler: async ({ params }) => {
        const state = await flags.execute({
          kind: "tenant",
          tenantId: params.tenantId,
        });
        if (!state.features.includes(notesExportFlag.slug)) throw notFound("NOT_FOUND", "Note export not available");
        const [note] = await db
          .select({ text: noteTable.text })
          .from(noteTable)
          .where(and(eq(noteTable.id, params.noteId), eq(noteTable.tenantId, params.tenantId)))
          .limit(1);
        if (!note) throw notFound("NOT_FOUND", "Note not found");
        return params.format === "csv" ? csvExport(note.text) : pdfExport(pdf, note.text);
      },
    }),
  ]);
}

function csvExport(text: string): { readonly contentType: "text/csv"; readonly base64: string } {
  const csv = toCsv([{ text: escapeCsvFormulaCell(text) }], [{ key: "text", header: "Note" }]);
  return {
    contentType: "text/csv",
    base64: Buffer.from(csv).toString("base64"),
  };
}

async function pdfExport(
  pdf: ReturnType<typeof createPdfRenderer>,
  text: string,
): Promise<{ readonly contentType: "application/pdf"; readonly base64: string }> {
  return {
    contentType: "application/pdf",
    base64: Buffer.from(await pdf.render({ content: ["Note", text] })).toString("base64"),
  };
}
