import { Workbook } from "exceljs";
import { describe, expect, it } from "vitest";

import { parseWorkbookContents, parseWorkbookRows } from "./parse-workbook.js";

async function writtenWorkbook(build: (workbook: Workbook) => void): Promise<ArrayBuffer> {
  const workbook = new Workbook();
  build(workbook);
  return workbook.xlsx.writeBuffer();
}

describe("parseWorkbookRows", () => {
  it("skips rows whose every cell is blank and keeps the sheet's row numbers", async () => {
    const data = await writtenWorkbook((workbook) => {
      const sheet = workbook.addWorksheet("Upload");
      sheet.addRow(["Name", "Amount"]);
      sheet.addRow(["Almonds", 12]);
      sheet.addRow(["   ", ""]);
      sheet.addRow([]);
      sheet.addRow(["Walnuts", 7]);
    });

    const rows = await parseWorkbookRows(data, "Upload");

    expect(rows.map((row) => row.rowNumber)).toEqual([2, 5]);
    expect(rows.map((row) => row.cells)).toEqual([
      { Name: "Almonds", Amount: "12" },
      { Name: "Walnuts", Amount: "7" },
    ]);
  });

  it("trims strings, renders numbers and dates as text, and drops blank-header columns", async () => {
    const data = await writtenWorkbook((workbook) => {
      const sheet = workbook.addWorksheet("Upload");
      sheet.addRow(["Name", "", "Amount", "Ordered On"]);
      sheet.addRow(["  Almonds  ", "ignored — its header is blank", 1234.5, new Date(Date.UTC(2026, 0, 15))]);
    });

    const rows = await parseWorkbookRows(data, "Upload");

    expect(rows).toEqual([
      {
        rowNumber: 2,
        cells: {
          Name: "Almonds",
          Amount: "1234.5",
          "Ordered On": "2026-01-15",
        },
      },
    ]);
  });

  it("throws when two columns share a header", async () => {
    const data = await writtenWorkbook((workbook) => {
      const sheet = workbook.addWorksheet("Upload");
      sheet.addRow(["Name", "Name"]);
      sheet.addRow(["a", "b"]);
    });

    await expect(parseWorkbookRows(data, "Upload")).rejects.toThrow('names "Name" twice');
  });

  it("throws when the named sheet is missing", async () => {
    const data = await writtenWorkbook((workbook) => {
      workbook.addWorksheet("Upload");
    });

    await expect(parseWorkbookRows(data, "Orders")).rejects.toThrow('no worksheet named "Orders"');
  });
});

describe("parseWorkbookContents", () => {
  it("reads the metadata and includes only requested visible sheets", async () => {
    const data = await writtenWorkbook((workbook) => {
      const metadata = workbook.addWorksheet("_Workbook Metadata", {
        state: "veryHidden",
      });
      metadata.addRow(["formatId", "example.order-import"]);
      metadata.addRow(["formatVersion", "2"]);
      const orders = workbook.addWorksheet("Orders");
      orders.addRow(["Order Key"]);
      orders.addRow(["ORDER-1"]);
      workbook.addWorksheet("Unrelated").addRow(["keep me"]);
    });
    await expect(parseWorkbookContents(data, ["Orders", "Releases"])).resolves.toEqual({
      metadata: {
        formatId: "example.order-import",
        formatVersion: "2",
      },
      sheets: [
        {
          sheetName: "Orders",
          rows: [{ rowNumber: 2, cells: { "Order Key": "ORDER-1" } }],
        },
      ],
    });
  });

  it("reads visible sheets in an ordinary workbook with foreign metadata", async () => {
    const data = await writtenWorkbook((workbook) => {
      const unrelated = workbook.addWorksheet("Imported Metadata", {
        state: "veryHidden",
      });
      unrelated.addRow(["formatId", "external.purchase"]);
      const purchase = workbook.addWorksheet("Purchase");
      purchase.addRow(["Line Number"]);
      purchase.addRow(["1"]);
    });

    const parsed = await parseWorkbookContents(data, ["Purchase"]);
    expect(parsed).toEqual({
      metadata: null,
      sheets: [
        {
          sheetName: "Purchase",
          rows: [{ rowNumber: 2, cells: { "Line Number": "1" } }],
        },
      ],
    });
  });
});
