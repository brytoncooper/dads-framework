import type { Workbook, CellValue, Row, Worksheet } from "exceljs";

import { createWorkbook } from "./create-workbook.js";
import { WORKBOOK_METADATA_SHEET_NAME } from "./workbook-spec.js";

/** One data row of an uploaded sheet, keyed by header-row text. */
export type ParsedSheetRow = {
  /** The sheet's own 1-based row number (the header row is 1). */
  readonly rowNumber: number;
  /** Trimmed cell text by header text; blank cells are omitted. */
  readonly cells: Readonly<Record<string, string>>;
};

/**
 * Read the named sheet of an uploaded .xlsx file into plain rows. Row 1 is
 * the header row and provides the keys; every value is coerced to a trimmed
 * string; rows whose every cell is blank are skipped.
 */
export async function parseWorkbookRows(data: ArrayBuffer, sheetName: string): Promise<readonly ParsedSheetRow[]> {
  const workbook = await createWorkbook();
  await workbook.xlsx.load(data);

  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) {
    throw new Error(`The workbook has no worksheet named "${sheetName}".`);
  }

  return readSheetRows(sheet);
}

/** One named sheet of an uploaded workbook, or omitted when that sheet is missing. */
export type ParsedWorkbookSheet = {
  readonly sheetName: string;
  readonly rows: readonly ParsedSheetRow[];
};

export type ParsedWorkbookContents = {
  readonly metadata: Readonly<Record<string, string>> | null;
  readonly sheets: readonly ParsedWorkbookSheet[];
};

/**
 * Load a workbook once and return its hidden metadata plus the named
 * visible sheets that exist.
 */
export async function parseWorkbookContents(
  data: ArrayBuffer,
  sheetNames: readonly string[],
): Promise<ParsedWorkbookContents> {
  const workbook = await createWorkbook();
  await workbook.xlsx.load(data);

  return {
    metadata: readWorkbookMetadata(workbook),
    sheets: existingSheets(workbook, sheetNames),
  };
}

/**
 * Read each named sheet that exists. Missing names are skipped so a user who
 * deleted an unused type sheet still uploads the rest.
 */
export async function parseWorkbookSheets(
  data: ArrayBuffer,
  sheetNames: readonly string[],
): Promise<readonly ParsedWorkbookSheet[]> {
  const workbook = await createWorkbook();
  await workbook.xlsx.load(data);
  return existingSheets(workbook, sheetNames);
}

function existingSheets(workbook: Workbook, sheetNames: readonly string[]): ParsedWorkbookSheet[] {
  return sheetNames.flatMap((sheetName) => {
    const sheet = workbook.getWorksheet(sheetName);
    if (sheet === undefined) return [];
    return [{ sheetName, rows: readSheetRows(sheet) }];
  });
}

function readWorkbookMetadata(workbook: Workbook): Readonly<Record<string, string>> | null {
  const sheet = workbook.getWorksheet(WORKBOOK_METADATA_SHEET_NAME);
  if (sheet === undefined) return null;

  const metadata: Record<string, string> = {};
  sheet.eachRow((row) => {
    const key = readCellText(row.getCell(1).value);
    const metadataValue = readCellText(row.getCell(2).value);
    if (key === "") return;
    if (metadata[key] !== undefined) {
      throw new Error(`The workbook metadata names "${key}" twice.`);
    }
    metadata[key] = metadataValue;
  });
  return metadata;
}

function readSheetRows(sheet: Worksheet): ParsedSheetRow[] {
  const headerByColumnNumber = readHeaderRow(sheet);
  const rows: ParsedSheetRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = readRowCells(row, headerByColumnNumber);
    if (Object.keys(cells).length === 0) return;
    rows.push({ rowNumber, cells });
  });
  return rows;
}

/** Maps column number to header text. Blank headers drop their column. */
function readHeaderRow(sheet: Worksheet): ReadonlyMap<number, string> {
  const headerByColumnNumber = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    if (cell.isMerged && cell.master.address !== cell.address) return;
    const header = readCellText(cell.value);
    if (header === "") return;
    if ([...headerByColumnNumber.values()].includes(header)) {
      throw new Error(`The header row names "${header}" twice — every column header must be unique.`);
    }
    headerByColumnNumber.set(columnNumber, header);
  });
  return headerByColumnNumber;
}

function readRowCells(row: Row, headerByColumnNumber: ReadonlyMap<number, string>): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const [columnNumber, header] of headerByColumnNumber) {
    const text = readCellText(row.getCell(columnNumber).value);
    if (text !== "") cells[header] = text;
  }
  return cells;
}

function readCellText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return numberToDecimalString(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return dateToIsoText(value);
  return readStructuredCellText(value);
}

function readStructuredCellText(
  value: Exclude<CellValue, string | number | boolean | Date | null | undefined>,
): string {
  if ("richText" in value) {
    return value.richText
      .map((run) => run.text)
      .join("")
      .trim();
  }
  if ("error" in value) return value.error;
  if ("hyperlink" in value) return value.text.trim();
  // Formula and shared-formula cells: use the cached result.
  return readCellText(value.result);
}

/** Decimal text, never exponent notation, for any finite number Excel holds. */
function numberToDecimalString(value: number): string {
  const text = String(value);
  if (!text.includes("e") && !text.includes("E")) return text;
  if (Number.isInteger(value)) return BigInt(value).toString();
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/** Midnight-UTC dates read as date-only text; anything else keeps its time. */
function dateToIsoText(value: Date): string {
  if (Number.isNaN(value.getTime())) return "";
  const iso = value.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}
