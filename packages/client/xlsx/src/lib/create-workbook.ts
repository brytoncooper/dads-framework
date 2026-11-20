import type { Workbook } from "exceljs";

/**
 * A fresh workbook, with `exceljs` fetched the first time one is needed.
 *
 * The engine is most of a megabyte, and only screens that export or import a
 * spreadsheet ever use it — so it is loaded here on demand instead of riding
 * in the bundle every visitor downloads before the first screen paints.
 */
export async function createWorkbook(): Promise<Workbook> {
  const { Workbook: WorkbookEngine } = await import("exceljs");
  return new WorkbookEngine();
}
