import { flexRender, type Table as TableInstance } from "@tanstack/react-table";
import * as React from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../display/index.js";

import { getColumnPinningStyle, readColumnWidth, readPinnedAttribute } from "../../lib/data-table.js";
import { type DataTableRowGroupOf, startsRowGroup } from "../../lib/row-groups.js";
import { DataTableBodyRow } from "./data-table-body-row.js";

export function DataTableDesktopContent<TData>({
  table,
  isUpdating,
  contentClassName,
  rowGroupOf,
  emptyState,
  hasRows,
}: {
  table: TableInstance<TData>;
  isUpdating: boolean;
  contentClassName: string | undefined;
  rowGroupOf: DataTableRowGroupOf<TData> | undefined;
  emptyState: React.ReactNode;
  hasRows: boolean;
}) {
  return (
    <div
      data-slot="data-table-content"
      aria-busy={isUpdating || undefined}
      className={contentClassName ?? "overflow-hidden rounded-md border"}
    >
      <Table trailingPinnedWidth={table.getRightTotalSize()}>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  colSpan={header.colSpan}
                  data-pinned={readPinnedAttribute(header.column)}
                  style={{
                    ...getColumnPinningStyle({
                      column: header.column,
                      withBorder: true,
                    }),
                    width: readColumnWidth(header.column, table.getVisibleLeafColumns()),
                  }}
                >
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {hasRows ? (
            table.getRowModel().rows.map((row, index, rows) => (
              <React.Fragment key={row.id}>
                {rowGroupOf !== undefined && startsRowGroup(rows, index, rowGroupOf) ? (
                  <TableRow data-slot="data-table-group-row">
                    <TableCell
                      colSpan={table.getVisibleLeafColumns().length}
                      className="bg-muted/50 py-1.5 font-semibold text-muted-foreground text-xs"
                    >
                      {rowGroupOf(row.original).label}
                    </TableCell>
                  </TableRow>
                ) : null}
                <DataTableBodyRow row={row} />
              </React.Fragment>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center">
                {emptyState}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
