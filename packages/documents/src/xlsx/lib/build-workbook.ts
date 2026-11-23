import { toArrayBuffer } from "./workbook-bytes.js";
import { isoDate } from "./workbook-date.js";
import type { Workbook, Worksheet } from "exceljs";

import { createWorkbook } from "./create-workbook.js";

import { WORKBOOK_METADATA_SHEET_NAME } from "./workbook-spec.js";
import type {
  WorkbookColumn,
  WorkbookInstructionSheetSpec,
  WorkbookSpec,
  WorkbookTableSheetSpec,
} from "./workbook-spec.js";

const DEFAULT_COLUMN_WIDTH_CHARS = 24;
const LOOKUPS_SHEET_NAME = "Lookups";
/** Existing templates cover rows 2..1000 unless a sheet asks for another cap. */
const DEFAULT_TEMPLATE_ROW_COUNT = 999;

/**
 * Build a .xlsx workbook from the spec: visible sheets with a bold, frozen
 * header row, the example rows, and per-column dropdowns backed by one hidden
 * `Lookups` sheet. Dropdowns always reference a lookup range — never an
 * inline joined list, which Excel caps at 255 characters.
 */
export async function buildWorkbook(spec: WorkbookSpec): Promise<ArrayBuffer> {
  const workbook = await createWorkbook();
  let nextLookupColumn = 1;

  for (const sheet of spec.sheets) {
    if (sheet.kind === "instructions") {
      writeInstructionSheet(workbook.addWorksheet(sheet.sheetName), sheet);
      continue;
    }

    const lastValidatedRow = (sheet.validatedDataRowCount ?? DEFAULT_TEMPLATE_ROW_COUNT) + 1;
    const dataSheet = workbook.addWorksheet(sheet.sheetName, {
      views: [
        {
          state: "frozen",
          ySplit: 1,
          xSplit: sheet.frozenColumnCount ?? 0,
        },
      ],
    });
    writeHeaderRow(dataSheet, sheet.columns);
    writeExampleRows(dataSheet, sheet);
    applyColumnFormats(dataSheet, sheet.columns, lastValidatedRow);
    applyHeaderFilter(dataSheet, sheet);
    nextLookupColumn = writeDropdowns(workbook, dataSheet, sheet.columns, nextLookupColumn, lastValidatedRow);
  }

  if (spec.metadata !== undefined) {
    writeMetadataSheet(workbook, spec.metadata);
  }

  return toArrayBuffer(await workbook.xlsx.writeBuffer());
}

function writeInstructionSheet(sheet: Worksheet, spec: WorkbookInstructionSheetSpec): void {
  sheet.columns = [{ width: 30 }, { width: 90 }];
  sheet.mergeCells("A1:B1");
  sheet.getCell("A1").value = spec.title;
  sheet.getCell("A1").font = { bold: true, size: 18 };

  let nextRowNumber = 3;
  if (spec.introduction !== undefined) {
    sheet.mergeCells(`A${String(nextRowNumber)}:B${String(nextRowNumber)}`);
    const introduction = sheet.getCell(nextRowNumber, 1);
    introduction.value = spec.introduction;
    introduction.alignment = { wrapText: true, vertical: "top" };
    nextRowNumber += 2;
  }

  for (const instruction of spec.instructions) {
    sheet.getCell(nextRowNumber, 1).value = instruction.heading;
    sheet.getCell(nextRowNumber, 1).font = { bold: true };
    sheet.getCell(nextRowNumber, 2).value = instruction.text;
    sheet.getCell(nextRowNumber, 2).alignment = {
      wrapText: true,
      vertical: "top",
    };
    nextRowNumber += 1;
  }
}

function writeHeaderRow(dataSheet: Worksheet, columns: readonly WorkbookColumn[]): void {
  dataSheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.widthChars ?? DEFAULT_COLUMN_WIDTH_CHARS,
  }));
  dataSheet.getRow(1).font = { bold: true };
  columns.forEach((column, index) => {
    if (column.required !== true) return;
    const header = dataSheet.getCell(1, index + 1);
    header.note = "Required column";
    header.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFE7B3" },
    };
  });
}

function writeExampleRows(dataSheet: Worksheet, spec: WorkbookTableSheetSpec): void {
  for (const exampleRow of spec.exampleRows ?? []) {
    const rowByColumnKey: Record<string, string | number | Date> = {};
    for (const column of spec.columns) {
      const exampleValue = exampleRow[column.key];
      if (exampleValue === undefined) continue;
      rowByColumnKey[column.key] = exampleCellValue(column, exampleValue);
    }
    dataSheet.addRow(rowByColumnKey);
  }
}

function exampleCellValue(column: WorkbookColumn, value: string): string | number | Date {
  if (column.cellKind === "date") return isoDate(value) ?? value;
  if (column.cellKind === "time") {
    const match = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(value);
    if (match === null) return value;
    return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) / 86400;
  }
  if (column.cellKind === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

function applyColumnFormats(dataSheet: Worksheet, columns: readonly WorkbookColumn[], lastValidatedRow: number): void {
  columns.forEach((column, index) => {
    const columnNumber = index + 1;
    if (column.cellKind === "text") {
      dataSheet.getColumn(columnNumber).numFmt = "@";
      return;
    }
    if (column.cellKind === "time") {
      dataSheet.getColumn(columnNumber).numFmt = "h:mm AM/PM";
      return;
    }
    if (column.cellKind !== "date") return;
    dataSheet.getColumn(columnNumber).numFmt = "yyyy-mm-dd";
    for (let rowNumber = 2; rowNumber <= lastValidatedRow; rowNumber += 1) {
      dataSheet.getCell(rowNumber, columnNumber).dataValidation = {
        type: "date",
        allowBlank: true,
        showErrorMessage: true,
        operator: "greaterThanOrEqual",
        formulae: [new Date(Date.UTC(1900, 0, 1))],
      };
    }
  });
}

function applyHeaderFilter(dataSheet: Worksheet, sheet: WorkbookTableSheetSpec): void {
  if (sheet.showFilter !== true || sheet.columns.length === 0) return;
  dataSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length },
  };
}

function writeDropdowns(
  workbook: Workbook,
  dataSheet: Worksheet,
  columns: readonly WorkbookColumn[],
  firstLookupColumn: number,
  lastValidatedRow: number,
): number {
  const dropdownColumns = columns.flatMap((column, index) =>
    column.dropdown === undefined || column.dropdown.values.length === 0
      ? []
      : [
          {
            header: `${dataSheet.name} ${column.header}`,
            values: column.dropdown.values,
            columnNumber: index + 1,
          },
        ],
  );
  if (dropdownColumns.length === 0) return firstLookupColumn;

  const lookupsSheet =
    workbook.getWorksheet(LOOKUPS_SHEET_NAME) ??
    workbook.addWorksheet(LOOKUPS_SHEET_NAME, {
      state: "veryHidden",
    });

  dropdownColumns.forEach((dropdownColumn, offset) => {
    const lookupRange = writeLookupColumn(lookupsSheet, firstLookupColumn + offset, dropdownColumn);
    applyListValidation(dataSheet, dropdownColumn.columnNumber, lookupRange, lastValidatedRow);
  });
  return firstLookupColumn + dropdownColumns.length;
}

/** Writes one dropdown's values into the Lookups sheet; returns their range. */
function writeLookupColumn(
  lookupsSheet: Worksheet,
  lookupColumnNumber: number,
  dropdownColumn: {
    readonly header: string;
    readonly values: readonly string[];
  },
): string {
  lookupsSheet.getCell(1, lookupColumnNumber).value = dropdownColumn.header;
  dropdownColumn.values.forEach((value, valueIndex) => {
    lookupsSheet.getCell(valueIndex + 2, lookupColumnNumber).value = value;
  });

  const letter = lookupsSheet.getColumn(lookupColumnNumber).letter;
  const lastLookupRow = dropdownColumn.values.length + 1;
  return `${LOOKUPS_SHEET_NAME}!$${letter}$2:$${letter}$${String(lastLookupRow)}`;
}

function applyListValidation(
  dataSheet: Worksheet,
  columnNumber: number,
  lookupRange: string,
  lastValidatedRow: number,
): void {
  for (let rowNumber = 2; rowNumber <= lastValidatedRow; rowNumber += 1) {
    dataSheet.getCell(rowNumber, columnNumber).dataValidation = {
      type: "list",
      allowBlank: true,
      showErrorMessage: true,
      formulae: [lookupRange],
    };
  }
}

function writeMetadataSheet(workbook: Workbook, metadata: NonNullable<WorkbookSpec["metadata"]>): void {
  const sheet = workbook.addWorksheet(WORKBOOK_METADATA_SHEET_NAME, {
    state: "veryHidden",
  });
  const entries = [
    ["formatId", metadata.formatId],
    ["formatVersion", String(metadata.formatVersion)],
    ...Object.entries(metadata.values ?? {}),
  ];
  for (const [index, entry] of entries.entries()) {
    const rowNumber = index + 1;
    sheet.getCell(rowNumber, 1).value = entry[0];
    sheet.getCell(rowNumber, 2).value = entry[1];
  }
}
