import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { xlsxWorkbookCodec } from "./workbook-codec.js";

describe("XLSX workbook contract", () => {
  it("preserves text IDs and normalized numbers, dates, sheet order, and metadata", async () => {
    const bytes = await xlsxWorkbookCodec.build({
      sheets: [
        {
          sheetName: "Inventory",
          columns: [
            { header: "SKU", key: "sku", cellKind: "text" },
            { header: "Count", key: "count", cellKind: "number" },
            { header: "Checked", key: "checked", cellKind: "date" },
          ],
          exampleRows: [{ sku: "000006", count: "1.5", checked: "2026-01-02" }],
          validatedDataRowCount: 1,
        },
        { sheetName: "Suppliers", columns: [], validatedDataRowCount: 1 },
      ],
      metadata: { formatId: "inventory", formatVersion: 1 },
    });

    await expect(
      xlsxWorkbookCodec.read(bytes, ["Suppliers", "Missing", "Inventory"]),
    ).resolves.toEqual({
      metadata: { formatId: "inventory", formatVersion: "1" },
      sheets: [
        { sheetName: "Suppliers", rows: [] },
        {
          sheetName: "Inventory",
          rows: [
            {
              rowNumber: 2,
              cells: { SKU: "000006", Count: "1.5", Checked: "2026-01-02" },
            },
          ],
        },
      ],
    });
  });

  it("reads and edits an independently authored SpreadsheetML workbook", async () => {
    const file = new URL(
      "../../test-fixtures/external-inventory.xlsx",
      import.meta.url,
    );
    const bytes = new Uint8Array(await readFile(file)).buffer;
    const expected = {
      metadata: null,
      sheets: [
        {
          sheetName: "Inventory",
          rows: [
            {
              rowNumber: 2,
              cells: { SKU: "0023", Count: "6", Available: "TRUE" },
            },
            {
              rowNumber: 4,
              cells: { SKU: "99999999999999999999", Available: "FALSE" },
            },
          ],
        },
      ],
    };

    await expect(xlsxWorkbookCodec.read(bytes, ["Inventory"])).resolves.toEqual(
      expected,
    );

    const updated = await xlsxWorkbookCodec.update(bytes, [
      {
        sheetName: "Inventory",
        rowNumber: 2,
        columnHeader: "SKU",
        value: "00045",
        cellKind: "text",
      },
    ]);
    const readBack = await xlsxWorkbookCodec.read(updated, ["Inventory"]);
    expect(readBack.metadata).toBeNull();
    expect(readBack.sheets[0]?.rows).toEqual([
      { rowNumber: 2, cells: { SKU: "00045", Count: "6", Available: "TRUE" } },
      {
        rowNumber: 4,
        cells: { SKU: "99999999999999999999", Available: "FALSE" },
      },
    ]);
  });
});
