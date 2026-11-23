import { posix } from "node:path";
import { strFromU8, unzipSync } from "fflate";

import type { ParsedSheetRow } from "../src/xlsx/lib/parse-workbook.js";

type WorkbookParts = ReturnType<typeof unzipSync>;

/** Independent reader for the portable table-cell subset of SpreadsheetML. */
class SpreadsheetMlReader {
  read(bytes: ArrayBuffer, sheetName: string): Promise<readonly ParsedSheetRow[]> {
    const parts = unzipSync(new Uint8Array(bytes));
    const sheet = readPart(parts, sheetPath(parts, sheetName));
    const strings = sharedStrings(parts);
    const rows = [...sheet.querySelectorAll("sheetData > row")];
    const [header, ...data] = rows;
    if (header === undefined) return Promise.resolve([]);
    const headers = cellValues(header, strings);
    return Promise.resolve(data.flatMap((row) => dataRow(row, headers, strings)));
  }
}

export function openSpreadsheetMlReader() {
  return new SpreadsheetMlReader();
}

function sheetPath(parts: WorkbookParts, name: string): string {
  const workbook = readPart(parts, "xl/workbook.xml");
  const sheet = [...workbook.querySelectorAll("sheet")].find((entry) => entry.getAttribute("name") === name);
  const id = sheet?.getAttribute("r:id");
  const relationships = readPart(parts, "xl/_rels/workbook.xml.rels");
  const relation = [...relationships.querySelectorAll("Relationship")].find((entry) => entry.getAttribute("Id") === id);
  const target = relation?.getAttribute("Target");
  if (!target) throw new Error(`Missing worksheet "${name}"`);
  return target.startsWith("/") ? target.slice(1) : posix.join("xl", target);
}

function readPart(parts: WorkbookParts, path: string): Document {
  const content = parts[path];
  if (content === undefined) throw new Error(`Missing workbook part "${path}"`);
  const document = new DOMParser().parseFromString(strFromU8(content), "application/xml");
  if (document.querySelector("parsererror")) throw new Error(`Invalid workbook XML in "${path}"`);
  return document;
}

function sharedStrings(parts: WorkbookParts): readonly string[] {
  if (parts["xl/sharedStrings.xml"] === undefined) return [];
  return [...readPart(parts, "xl/sharedStrings.xml").querySelectorAll("si")].map((entry) => entry.textContent);
}

function cellValues(row: Element, strings: readonly string[]): ReadonlyMap<string, string> {
  const cells = new Map<string, string>();
  for (const cell of row.querySelectorAll("c")) {
    const column = cell.getAttribute("r")?.match(/^[A-Z]+/)?.[0];
    if (column === undefined) continue;
    const content = cellText(cell, strings).trim();
    if (content !== "") cells.set(column, content);
  }
  return cells;
}

function cellText(cell: Element, strings: readonly string[]): string {
  const value = cell.querySelector("v")?.textContent ?? "";
  switch (cell.getAttribute("t")) {
    case "inlineStr":
      return cell.querySelector("is")?.textContent ?? "";
    case "s":
      return strings[Number(value)] ?? "";
    case "b":
      return value === "1" ? "TRUE" : "FALSE";
    default:
      return value;
  }
}

function dataRow(
  row: Element,
  headers: ReadonlyMap<string, string>,
  strings: readonly string[],
): readonly ParsedSheetRow[] {
  const cells = new Map<string, string>();
  for (const [column, value] of cellValues(row, strings)) {
    const header = headers.get(column);
    if (header !== undefined) cells.set(header, value);
  }
  if (cells.size === 0) return [];
  return [
    {
      rowNumber: Number(row.getAttribute("r")),
      cells: Object.fromEntries(cells),
    },
  ];
}
