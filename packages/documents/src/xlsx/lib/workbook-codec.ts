import { buildWorkbook } from "./build-workbook.js";
import { parseWorkbookContents, type ParsedWorkbookContents } from "./parse-workbook.js";
import { updateWorkbookCells, type WorkbookCellUpdate } from "./update-workbook.js";
import type { WorkbookSpec } from "./workbook-spec.js";

/** Builds a workbook, reads its visible data, and applies source-located edits. */
export type WorkbookCodec = {
  build(spec: WorkbookSpec): Promise<ArrayBuffer>;
  read(data: ArrayBuffer, sheetNames: readonly string[]): Promise<ParsedWorkbookContents>;
  update(data: ArrayBuffer, updates: readonly WorkbookCellUpdate[]): Promise<ArrayBuffer>;
};

export const xlsxWorkbookCodec: WorkbookCodec = {
  build: buildWorkbook,
  read: parseWorkbookContents,
  update: updateWorkbookCells,
};
