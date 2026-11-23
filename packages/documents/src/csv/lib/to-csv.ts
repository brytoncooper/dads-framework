import { readCsvColumn } from "./read-csv-column.js";

export type CsvColumn = {
  /** Property name or nested property path on each row object. */
  key: string;
  /** Header cell text. */
  header: string;
};

/** Formats rows using comma separators, quoted fields, and LF line endings. */
export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly CsvColumn[],
): string {
  const headers = columns.map(({ key, header }) => {
    if (key.length === 0) throw new TypeError("CSV column key is required");
    return quoteCell(header);
  });
  const lines = [headers.join(",")];
  for (const row of rows) {
    const fields = columns.map(({ key }) =>
      serializeCell(readCsvColumn(row, key)),
    );
    lines.push(fields.join(","));
  }
  return `${lines.join("\n")}\n`;
}

function serializeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return quoteCell(value);
  if (typeof value === "boolean") return value ? "1" : "";
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === "object")
    return quoteCell(serializeStructuredCell(value));
  throw new TypeError(`Unsupported CSV cell type: ${typeof value}`);
}

function serializeStructuredCell(value: object): string {
  const json: unknown = JSON.stringify(value);
  return typeof json === "string" ? json : "";
}

function quoteCell(text: string): string {
  return /[,\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
