import type { Column, Table } from "@tanstack/react-table";
import { Columns3 } from "lucide-react";

import { Button } from "../../../elements/index.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { readColumnLabel } from "../../lib/column-label.js";
import { readReaderHideableColumns, showAllColumns } from "../../lib/reader-hidden-columns.js";

/**
 * The toolbar's Columns menu: one checkbox per column the reader may hide,
 * plus Show All. Nothing is hidden until the reader unticks it here; the
 * identifying, selection, and actions columns are never offered.
 */
export function DataTableColumnsMenu<TData>({ table }: { readonly table: Table<TData> }) {
  const t = useDataTableCopy();
  const columns = readReaderHideableColumns(table);
  if (columns.length === 0) return null;
  const anyHidden = columns.some((column) => !column.getIsVisible());

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Columns3 aria-hidden="true" />
          {t("dataTable.action.columns")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t("dataTable.columns.heading")}</DropdownMenuLabel>
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(checked) => {
              column.toggleVisibility(checked);
            }}
            onSelect={(event) => {
              event.preventDefault();
            }}
          >
            {labelOf(column)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!anyHidden}
          onSelect={() => {
            showAllColumns(table);
          }}
        >
          {t("dataTable.action.showAllColumns")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function labelOf<TData>(column: Column<TData>): string {
  return readColumnLabel({
    id: column.id,
    metaLabel: column.columnDef.meta?.label,
    header: column.columnDef.header,
  });
}
