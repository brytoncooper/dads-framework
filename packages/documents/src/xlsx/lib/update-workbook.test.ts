/**
 * What: corrected-workbook output changes only source-located cells and keeps
 * unrelated workbook content, formulas, notes, and exact text intact.
 */
import { Workbook } from "exceljs";
import { describe, expect, it } from "vitest";
import { parseWorkbookRows } from "./parse-workbook.js";
import { updateWorkbookCells } from "./update-workbook.js";

async function correctionWorkbook(): Promise<ArrayBuffer> {
  const workbook = new Workbook();
  const releases = workbook.addWorksheet("Releases");
  releases.addRow(["Order Key", "Release Number", "Pickup Start"]);
  releases.addRow(["ORDER-1", "000001", new Date(Date.UTC(2026, 8, 1))]);
  releases.getCell("B2").note = "Customer supplied";
  const unrelated = workbook.addWorksheet("Calculations");
  unrelated.getCell("A1").value = 2;
  unrelated.getCell("A2").value = 3;
  unrelated.getCell("A3").value = { formula: "SUM(A1:A2)", result: 5 };
  return workbook.xlsx.writeBuffer();
}

describe("updateWorkbookCells", () => {
  it("updates exact cells while preserving unrelated workbook content", async () => {
    const updated = await updateWorkbookCells(await correctionWorkbook(), [
      {
        sheetName: "Releases",
        rowNumber: 2,
        columnHeader: "Release Number",
        value: "000009",
        cellKind: "text",
      },
      {
        sheetName: "Releases",
        rowNumber: 2,
        columnHeader: "Pickup Start",
        value: "2026-09-15",
        cellKind: "date",
      },
    ]);

    expect(await parseWorkbookRows(updated, "Releases")).toEqual([
      {
        rowNumber: 2,
        cells: {
          "Order Key": "ORDER-1",
          "Release Number": "000009",
          "Pickup Start": "2026-09-15",
        },
      },
    ]);

    const workbook = new Workbook();
    await workbook.xlsx.load(updated);
    expect(workbook.getWorksheet("Releases")?.getCell("B2").note).toBe("Customer supplied");
    expect(workbook.getWorksheet("Calculations")?.getCell("A3").value).toEqual({
      formula: "SUM(A1:A2)",
      result: 5,
    });
  });

  it("fails loudly when a requested sheet or column is missing", async () => {
    const sourceWorkbook = await correctionWorkbook();
    await expect(
      updateWorkbookCells(sourceWorkbook, [
        {
          sheetName: "Missing",
          rowNumber: 2,
          columnHeader: "Release Number",
          value: "1",
        },
      ]),
    ).rejects.toThrow('no worksheet named "Missing"');

    await expect(
      updateWorkbookCells(sourceWorkbook, [
        {
          sheetName: "Releases",
          rowNumber: 2,
          columnHeader: "Missing Column",
          value: "1",
        },
      ]),
    ).rejects.toThrow('has no "Missing Column" column');
  });
});
