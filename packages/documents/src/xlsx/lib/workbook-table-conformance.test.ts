// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Workbook } from "exceljs";
import { expect, it } from "vitest";

import { openExcelJsWorkbookReader } from "../../../test-support-xlsx/exceljs-workbook-reader.js";
import { openSpreadsheetMlReader } from "../../../test-support-xlsx/spreadsheetml-reader.js";
import { runWorkbookTableReaderLaws } from "../../../test-support-xlsx/workbook-table-reader-laws.js";

runWorkbookTableReaderLaws(
  () => openExcelJsWorkbookReader(),
  (name, run) => {
    it(`ExcelJS ${name}`, async () => {
      await run(await inventoryWorkbook());
      await run(await independentWorkbook());
    });
  },
);

runWorkbookTableReaderLaws(
  () => openSpreadsheetMlReader(),
  (name, run) => {
    it(`independent SpreadsheetML reader ${name}`, async () => {
      await run(await inventoryWorkbook());
      await run(await independentWorkbook());
    });
  },
);

async function inventoryWorkbook(): Promise<ArrayBuffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("Inventory");
  sheet.addRow(["SKU", "Count", "Available"]);
  sheet.addRow(["0023", { formula: "2*3", result: 6 }, true]);
  sheet.getRow(4).values = ["99999999999999999999", undefined, false];
  const written = await workbook.xlsx.writeBuffer();
  if (ArrayBuffer.isView(written)) return new Uint8Array(written).buffer;
  return written;
}

async function independentWorkbook(): Promise<ArrayBuffer> {
  const testPath = expect.getState().testPath;
  if (testPath === undefined) throw new Error("Workbook test file is unknown");
  const fixture = join(dirname(testPath), "../../../test-fixtures-xlsx/external-inventory.xlsx");
  return new Uint8Array(await readFile(fixture)).buffer;
}
