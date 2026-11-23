import { Workbook } from "exceljs";
import { describe, expect, it } from "vitest";

import { buildWorkbook } from "./build-workbook.js";
import { parseWorkbookRows } from "./parse-workbook.js";
import type { WorkbookSpec } from "./workbook-spec.js";

const orderTemplateSpec: WorkbookSpec = {
  sheets: [
    {
      sheetName: "Orders",
      columns: [
        { header: "Order Ref", key: "orderRef" },
        {
          header: "Product Code",
          key: "productCode",
          widthChars: 30,
          dropdown: { values: ["ALM-27", "WAL-CHAND-01", "PST-14"] },
        },
        { header: "Quantity", key: "quantity", widthChars: 12 },
      ],
      exampleRows: [{ orderRef: "PO-1001", productCode: "ALM-27", quantity: "44000" }],
    },
  ],
};

describe("buildWorkbook", () => {
  it("round-trips the example row through parseWorkbookRows, keyed by header text", async () => {
    const built = await buildWorkbook(orderTemplateSpec);

    const rows = await parseWorkbookRows(built, "Orders");

    // Intended asymmetry: buildWorkbook writes headers from `header` and maps
    // example rows by column `key`; parseWorkbookRows keys cells by the header
    // TEXT because it reads user-edited files, not the spec.
    expect(rows).toEqual([
      {
        rowNumber: 2,
        cells: {
          "Order Ref": "PO-1001",
          "Product Code": "ALM-27",
          Quantity: "44000",
        },
      },
    ]);
  });

  it("freezes and bolds the header row", async () => {
    const built = await buildWorkbook(orderTemplateSpec);

    const workbook = new Workbook();
    await workbook.xlsx.load(built);
    const orders = workbook.getWorksheet("Orders");
    if (orders === undefined) throw new Error("Orders sheet missing");

    const view = orders.views[0];
    if (view?.state !== "frozen") throw new Error("expected a frozen view");
    expect(view.ySplit).toBe(1);
    expect(orders.getRow(1).font.bold).toBe(true);
  });

  it("backs the dropdown column with a hidden Lookups sheet and a list validation", async () => {
    const built = await buildWorkbook(orderTemplateSpec);

    const workbook = new Workbook();
    await workbook.xlsx.load(built);

    const lookups = workbook.getWorksheet("Lookups");
    if (lookups === undefined) throw new Error("Lookups sheet missing");
    expect(lookups.state).toBe("veryHidden");
    expect(lookups.getCell("A1").value).toBe("Orders Product Code");
    expect(lookups.getCell("A2").value).toBe("ALM-27");
    expect(lookups.getCell("A3").value).toBe("WAL-CHAND-01");
    expect(lookups.getCell("A4").value).toBe("PST-14");

    const orders = workbook.getWorksheet("Orders");
    if (orders === undefined) throw new Error("Orders sheet missing");
    const firstDataCell = orders.getCell("B2").dataValidation;
    expect(firstDataCell.type).toBe("list");
    const formulae: unknown = firstDataCell.formulae;
    expect(formulae).toEqual(["Lookups!$A$2:$A$4"]);

    const lastValidatedCell = orders.getCell("B1000").dataValidation;
    expect(lastValidatedCell.type).toBe("list");
    expect(orders.getCell("A2").dataValidation).toBeUndefined();
  });

  it("writes date columns as Excel dates with a date format and validation", async () => {
    const built = await buildWorkbook({
      sheets: [
        {
          sheetName: "Orders",
          columns: [{ header: "Start Date", key: "startDate", cellKind: "date" }],
          exampleRows: [{ startDate: "2026-09-15" }],
        },
      ],
    });

    const workbook = new Workbook();
    await workbook.xlsx.load(built);
    const orders = workbook.getWorksheet("Orders");
    if (orders === undefined) throw new Error("Orders sheet missing");
    expect(orders.getCell("A2").value).toBeInstanceOf(Date);
    expect(orders.getColumn(1).numFmt).toBe("yyyy-mm-dd");
    expect(orders.getCell("A2").dataValidation.type).toBe("date");
    expect(orders.getCell("A1000").dataValidation.type).toBe("date");
  });

  it("writes number columns as Excel numbers so fill-down can increment them", async () => {
    const built = await buildWorkbook({
      sheets: [
        {
          sheetName: "Orders",
          columns: [
            {
              header: "Release Number",
              key: "releaseNumber",
              cellKind: "number",
            },
          ],
          exampleRows: [{ releaseNumber: "1" }, { releaseNumber: "2" }],
        },
      ],
    });

    const workbook = new Workbook();
    await workbook.xlsx.load(built);
    const orders = workbook.getWorksheet("Orders");
    if (orders === undefined) throw new Error("Orders sheet missing");
    expect(orders.getCell("A2").value).toBe(1);
    expect(orders.getCell("A3").value).toBe(2);
  });

  it("forces opaque text columns to preserve leading zeros and long numeric-looking values", async () => {
    const built = await buildWorkbook({
      sheets: [
        {
          sheetName: "Releases",
          columns: [
            {
              header: "Release Number",
              key: "releaseNumber",
              cellKind: "text",
            },
          ],
          exampleRows: [
            { releaseNumber: "000001" },
            { releaseNumber: "12345678901234567890" },
            { releaseNumber: "Ab-01/XY" },
          ],
        },
      ],
    });

    const workbook = new Workbook();
    await workbook.xlsx.load(built);
    const releases = workbook.getWorksheet("Releases");
    if (releases === undefined) throw new Error("Releases sheet missing");
    expect(releases.getColumn(1).numFmt).toBe("@");
    expect(releases.getCell("A2").value).toBe("000001");
    expect(releases.getCell("A3").value).toBe("12345678901234567890");
    expect(releases.getCell("A4").value).toBe("Ab-01/XY");

    const parsed = await parseWorkbookRows(built, "Releases");
    expect(parsed.map((row) => row.cells["Release Number"])).toEqual(["000001", "12345678901234567890", "Ab-01/XY"]);
  });

  it("writes instructions, metadata, required markers, filters, frozen keys, and a custom validation extent", async () => {
    const built = await buildWorkbook({
      metadata: {
        formatId: "example.order-import",
        formatVersion: 2,
        values: { managingOrganizationId: "org-1" },
      },
      sheets: [
        {
          sheetName: "Read Me",
          kind: "instructions",
          title: "Import Orders",
          introduction: "Use one key across the three data sheets.",
          instructions: [{ heading: "1. Orders", text: "Add one row per order." }],
        },
        {
          sheetName: "Orders",
          kind: "reference",
          columns: [
            {
              header: "Order Key",
              key: "orderKey",
              required: true,
              cellKind: "text",
              dropdown: { values: ["ORDER-1"] },
            },
            { header: "Notes", key: "notes" },
          ],
          frozenColumnCount: 1,
          showFilter: true,
          validatedDataRowCount: 2_000,
        },
      ],
    });

    const workbook = new Workbook();
    await workbook.xlsx.load(built);
    const readMe = workbook.getWorksheet("Read Me");
    const orders = workbook.getWorksheet("Orders");
    const metadata = workbook.getWorksheet("_Workbook Metadata");
    if (readMe === undefined || orders === undefined || metadata === undefined) {
      throw new Error("Expected workbook sheets are missing");
    }

    expect(readMe.getCell("A1").value).toBe("Import Orders");
    expect(readMe.getCell("A5").value).toBe("1. Orders");
    expect(metadata.state).toBe("veryHidden");
    expect(metadata.getCell("A1").value).toBe("formatId");
    expect(metadata.getCell("B2").value).toBe("2");
    expect(orders.getCell("A1").note).toBe("Required column");
    expect(orders.autoFilter).toBe("A1:B1");
    const view = orders.views[0];
    if (view?.state !== "frozen") throw new Error("expected a frozen view");
    expect(view.xSplit).toBe(1);
    expect(orders.getCell("A2001").dataValidation.type).toBe("list");
  });

  it("round-trips a date column as yyyy-mm-dd text", async () => {
    const built = await buildWorkbook({
      sheets: [
        {
          sheetName: "Orders",
          columns: [{ header: "Start Date", key: "startDate", cellKind: "date" }],
          exampleRows: [{ startDate: "2026-09-15" }],
        },
      ],
    });

    expect(await parseWorkbookRows(built, "Orders")).toEqual([{ rowNumber: 2, cells: { "Start Date": "2026-09-15" } }]);
  });
});
