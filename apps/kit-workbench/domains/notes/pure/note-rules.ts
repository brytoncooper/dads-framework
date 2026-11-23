export type NoteExportFormat = "csv" | "pdf";

export type NoteRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly text: string;
};

/** Normalize line endings and surrounding whitespace before persisting a note. */
export function normalizeNoteText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").trim();
}

/** Build a normalized note record from explicit inputs without ambient ID or clock access. */
export function createNoteRecord(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly text: string;
}): NoteRecord {
  return {
    id: input.id,
    tenantId: input.tenantId,
    text: normalizeNoteText(input.text),
  };
}

/** Neutralize spreadsheet formula prefixes before serializing note text to CSV. */
export function escapeCsvFormulaCell(text: string): string {
  return /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

/** Build a deterministic, filesystem-safe download filename for a note export. */
export function buildNoteExportFilename(noteId: string, format: NoteExportFormat): string {
  const shortId = noteId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "")
    .slice(0, 8);
  const stem = shortId.length > 0 ? `note-${shortId}` : "note";
  return `${stem}.${format}`;
}
