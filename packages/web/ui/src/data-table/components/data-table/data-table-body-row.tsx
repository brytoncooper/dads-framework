import { flexRender, type Row } from "@tanstack/react-table";
import * as React from "react";

import { TableCell, TableRow } from "../../../display/index.js";

import { getColumnPinningStyle, readColumnWidth, readPinnedAttribute } from "../../lib/data-table.js";
import { readPrimaryRowLink, samePrimaryRowLink } from "../../lib/read-primary-row-link.js";
import { DataTableRowHitArea } from "./data-table-row-hit-area.js";

export function DataTableBodyRow<TData>({ row }: { readonly row: Row<TData> }) {
  const rowRef = React.useRef<HTMLTableRowElement>(null);
  const [rowLink, setRowLink] = React.useState<{
    href: string;
    cellIndex: number;
  } | null>(null);

  const visibleCellKey = row
    .getVisibleCells()
    .map((cell) => cell.id)
    .join("|");

  React.useLayoutEffect(() => {
    const rowElement = rowRef.current;
    setRowLink((current) => {
      const next = rowElement ? readPrimaryRowLink(rowElement) : null;
      return samePrimaryRowLink(current, next) ? current : next;
    });
  }, [row.id, visibleCellKey]);

  return (
    <TableRow ref={rowRef} data-state={row.getIsSelected() && "selected"}>
      {row.getVisibleCells().map((cell, cellIndex) => (
        <TableCell
          key={cell.id}
          className={cell.column.columnDef.meta?.cellClassName}
          data-pinned={readPinnedAttribute(cell.column)}
          style={{
            ...getColumnPinningStyle({ column: cell.column, withBorder: true }),
            width: readColumnWidth(cell.column, cell.getContext().table.getVisibleLeafColumns()),
          }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
          {rowLink && cellIndex !== rowLink.cellIndex ? <DataTableRowHitArea href={rowLink.href} /> : null}
        </TableCell>
      ))}
    </TableRow>
  );
}
