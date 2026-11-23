import { toArrayBuffer } from "./workbook-bytes.js";
import { isoDate } from "./workbook-date.js";
import type { Workbook, Cell, Worksheet } from "exceljs";

import { createWorkbook } from "./create-workbook.js";

export type WorkbookCellUpdate = {
  readonly sheetName: string;
  readonly rowNumber: number;
  readonly columnHeader: string;
  readonly value: string | null;
  readonly cellKind?: "date" | "number" | "text";
};

/**
 * Apply source-located cell changes to an existing workbook. Sheets, cells,
 * formatting, formulas, and notes outside the named cells are left intact.
 */
export async function updateWorkbookCells(
  data: ArrayBuffer,
  updates: readonly WorkbookCellUpdate[],
): Promise<ArrayBuffer> {
  const workbook = await createWorkbook();
  await workbook.xlsx.load(data);

  const headerColumnsBySheet = new Map<string, ReadonlyMap<string, number>>();
  for (const update of updates) {
    const sheet = requiredSheet(workbook, update.sheetName);
    const headerColumns = headerColumnsBySheet.get(update.sheetName) ?? readHeaderColumns(sheet);
    headerColumnsBySheet.set(update.sheetName, headerColumns);
    const columnNumber = headerColumns.get(update.columnHeader);
    if (columnNumber === undefined) {
      throw new Error(`The "${update.sheetName}" sheet has no "${update.columnHeader}" column.`);
    }
    writeUpdatedCell(sheet.getCell(update.rowNumber, columnNumber), update);
  }

  return toArrayBuffer(await workbook.xlsx.writeBuffer());
}

function requiredSheet(workbook: Workbook, sheetName: string): Worksheet {
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) {
    throw new Error(`The workbook has no worksheet named "${sheetName}".`);
  }
  return sheet;
}

function readHeaderColumns(sheet: Worksheet): ReadonlyMap<string, number> {
  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    const header = cell.text.trim();
    if (header === "") return;
    if (columns.has(header)) {
      throw new Error(`The header row names "${header}" twice — every column header must be unique.`);
    }
    columns.set(header, columnNumber);
  });
  return columns;
}

function writeUpdatedCell(cell: Cell, update: WorkbookCellUpdate): void {
  if (update.value === null) {
    cell.value = null;
    return;
  }
  if (update.cellKind === "text") {
    cell.numFmt = "@";
    cell.value = update.value;
    return;
  }
  if (update.cellKind === "number") {
    const number = Number(update.value);
    cell.value = Number.isFinite(number) ? number : update.value;
    return;
  }
  if (update.cellKind === "date") {
    cell.numFmt = "yyyy-mm-dd";
    cell.value = isoDate(update.value) ?? update.value;
    return;
  }
  cell.value = update.value;
}
