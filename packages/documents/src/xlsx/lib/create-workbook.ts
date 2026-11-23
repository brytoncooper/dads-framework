import type { Workbook } from "exceljs";

import { loadOptionalPeer } from "../../optional-peer.js";

type WorkbookConstructor = new () => Workbook;

function isWorkbookConstructor(value: unknown): value is WorkbookConstructor {
  return typeof value === "function";
}

function workbookConstructorFrom(
  value: unknown,
): WorkbookConstructor | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "Workbook" in value &&
    isWorkbookConstructor(value.Workbook)
  ) {
    return value.Workbook;
  }
  return undefined;
}

function unwrapWorkbookConstructor(loaded: unknown): WorkbookConstructor {
  const direct = workbookConstructorFrom(loaded);
  if (direct !== undefined) return direct;
  if (typeof loaded === "object" && loaded !== null && "default" in loaded) {
    const nested = workbookConstructorFrom(loaded.default);
    if (nested !== undefined) return nested;
  }
  throw new Error("exceljs did not export a Workbook constructor");
}

/**
 * A fresh workbook, with `exceljs` fetched the first time one is needed.
 *
 * The engine is most of a megabyte, and only screens that export or import a
 * spreadsheet ever use it — so it is loaded here on demand instead of riding
 * in the bundle every visitor downloads before the first screen paints.
 */
export async function createWorkbook(
  load: () => Promise<unknown> = () => import("exceljs"),
): Promise<Workbook> {
  const loaded = await loadOptionalPeer(
    "@dads-framework/documents/xlsx",
    "exceljs",
    load,
  );
  const WorkbookEngine = unwrapWorkbookConstructor(loaded);
  return new WorkbookEngine();
}
