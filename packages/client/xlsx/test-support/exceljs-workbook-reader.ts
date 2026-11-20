import { parseWorkbookRows } from "../src/lib/parse-workbook.js";

class ExcelJsWorkbookReader {
  read(bytes: ArrayBuffer, sheetName: string) {
    return parseWorkbookRows(bytes, sheetName);
  }
}

export function openExcelJsWorkbookReader() {
  return new ExcelJsWorkbookReader();
}
