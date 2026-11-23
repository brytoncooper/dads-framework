type CsvCursor = {
  readonly text: string;
  index: number;
};

/** Parses RFC 4180 CSV text into rows of string cells. */
export function parseCsv(text: string): readonly (readonly string[])[] {
  const content = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (content.length === 0) return [];
  const cursor: CsvCursor = { text: content, index: 0 };
  const rows: string[][] = [];
  while (cursor.index < content.length) {
    rows.push(readCsvRow(cursor));
  }
  return rows;
}

/** Parses RFC 4180 CSV text using the first row as column header keys. */
export function parseCsvRecords(text: string): readonly Readonly<Record<string, string>>[] {
  const [headers, ...bodyRows] = parseCsv(text);
  if (headers === undefined) return [];
  return bodyRows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function readCsvRow(cursor: CsvCursor): string[] {
  const row: string[] = [];
  for (;;) {
    row.push(readCsvField(cursor));
    if (cursor.text[cursor.index] === ",") {
      cursor.index += 1;
      continue;
    }
    consumeLineBreak(cursor);
    return row;
  }
}

function readCsvField(cursor: CsvCursor): string {
  return cursor.text[cursor.index] === '"' ? readQuotedField(cursor) : readUnquotedField(cursor);
}

function readQuotedField(cursor: CsvCursor): string {
  cursor.index += 1;
  let value = "";
  let segmentStart = cursor.index;
  while (cursor.index < cursor.text.length) {
    if (cursor.text[cursor.index] !== '"') {
      cursor.index += 1;
      continue;
    }
    value += cursor.text.slice(segmentStart, cursor.index);
    if (cursor.text[cursor.index + 1] === '"') {
      value += '"';
      cursor.index += 2;
      segmentStart = cursor.index;
      continue;
    }
    cursor.index += 1;
    assertFieldBoundary(cursor);
    return value;
  }
  throw new SyntaxError("Unterminated quoted CSV field");
}

function assertFieldBoundary(cursor: CsvCursor): void {
  const next = cursor.text[cursor.index];
  if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") {
    throw new SyntaxError("Unexpected character after closing CSV quote");
  }
}

function readUnquotedField(cursor: CsvCursor): string {
  const start = cursor.index;
  while (cursor.index < cursor.text.length) {
    const ch = cursor.text[cursor.index];
    if (ch === "," || ch === "\n" || ch === "\r") break;
    if (ch === '"') throw new SyntaxError("Unexpected quote in unquoted CSV field");
    cursor.index += 1;
  }
  return cursor.text.slice(start, cursor.index);
}

function consumeLineBreak(cursor: CsvCursor): void {
  const ch = cursor.text[cursor.index];
  if (ch === "\r") {
    cursor.index += cursor.text[cursor.index + 1] === "\n" ? 2 : 1;
  } else if (ch === "\n") {
    cursor.index += 1;
  }
}
