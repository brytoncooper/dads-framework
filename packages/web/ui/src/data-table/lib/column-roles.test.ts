/**
 * What: the identifying, selection, and actions columns are pinned and can
 * never be hidden; every other column is the reader's to hide.
 * Why: a row must stay recognisable and actionable at any width, and only the
 * reader — never the screen width — decides that a column goes out of view.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";

import {
  defaultColumnPinning,
  pickReaderVisibility,
  readColumnDefId,
  readHideableColumnIds,
  readIdentifyingColumnId,
  showEveryHideableColumn,
  withColumnRoles,
} from "./column-roles.js";

type Row = { name: string; status: string; amount: number };

const COLUMNS: ColumnDef<Row>[] = [
  { id: "select" },
  { accessorKey: "name" },
  { id: "status", accessorKey: "status" },
  { id: "amount", accessorKey: "amount", enableHiding: false },
  { id: "actions" },
];

describe("column roles", () => {
  it("reads a definition's id from its id, else its accessor key", () => {
    expect(COLUMNS.map((column) => readColumnDefId(column))).toEqual(["select", "name", "status", "amount", "actions"]);
  });

  it("treats the first non-selection column as the identifying column", () => {
    expect(readIdentifyingColumnId(COLUMNS)).toBe("name");
  });

  it("never lets the reader hide the identifying, selection, or actions columns", () => {
    const hideable = readHideableColumnIds(withColumnRoles(COLUMNS));
    expect([...hideable]).toEqual(["status"]);
  });

  it("pins selection and the identifying column left and actions right", () => {
    expect(defaultColumnPinning(COLUMNS)).toEqual({
      left: ["select", "name"],
      right: ["actions"],
    });
    expect(defaultColumnPinning([{ id: "selection" }, ...COLUMNS.slice(1, 3)])).toEqual({
      left: ["selection", "name"],
      right: [],
    });
    expect(defaultColumnPinning(COLUMNS.slice(1, 3))).toEqual({
      left: ["name"],
      right: [],
    });
  });

  it("remembers only the columns the reader controls", () => {
    expect(pickReaderVisibility({ status: false, amount: false }, new Set(["status"]))).toEqual({ status: false });
  });

  it("shows every hideable column again without touching the rest", () => {
    expect(showEveryHideableColumn({ status: false, amount: false }, ["status"])).toEqual({
      status: true,
      amount: false,
    });
  });
});
