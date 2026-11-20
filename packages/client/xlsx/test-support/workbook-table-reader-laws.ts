import { deepEqual } from "node:assert/strict";
import type { ParsedSheetRow } from "../src/lib/parse-workbook.js";

type WorkbookTableReader = {
  read(
    bytes: ArrayBuffer,
    sheetName: string,
  ): Promise<readonly ParsedSheetRow[]>;
};

type ReaderLaw = (bytes: ArrayBuffer) => Promise<void>;

export function runWorkbookTableReaderLaws(
  open: () => WorkbookTableReader,
  register: (title: string, law: ReaderLaw) => void,
): void {
  register(
    "preserves identifiers, cached numeric values, and sparse row positions",
    async (bytes) => {
      const rows = await open().read(bytes, "Inventory");
      deepEqual(rows, [
        { rowNumber: 2, cells: { SKU: "0023", Count: "6", Available: "TRUE" } },
        {
          rowNumber: 4,
          cells: { SKU: "99999999999999999999", Available: "FALSE" },
        },
      ]);
    },
  );
}
