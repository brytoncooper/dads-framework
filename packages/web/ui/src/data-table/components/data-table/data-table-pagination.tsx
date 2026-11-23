import type { Table } from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { FormattedInteger } from "../../../copy/index.js";
import { Button, cn } from "../../../elements/index.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../forms/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";

type DataTablePaginationProps<TData> = React.ComponentProps<"div"> & {
  table: Table<TData>;
  pageSizeOptions?: number[];
  withSelectionStatus?: boolean;
};

export function DataTablePagination<TData>({
  table,
  pageSizeOptions = [10, 25, 50, 100],
  withSelectionStatus = false,
  className,
  ...props
}: DataTablePaginationProps<TData>) {
  const t = useDataTableCopy();
  const pageCount = Math.max(table.getPageCount(), 1);
  const currentPage = Math.min(
    table.getState().pagination.pageIndex + 1,
    pageCount,
  );

  return (
    <div
      {...props}
      data-slot="data-table-pagination"
      className={cn(
        "flex w-full flex-col flex-wrap gap-4 p-1 sm:flex-row sm:items-center sm:justify-between sm:gap-8",
        className,
      )}
    >
      {withSelectionStatus && (
        <div className="w-full min-w-0 text-center text-foreground text-sm sm:flex-1 sm:text-left">
          {t(
            "dataTable.pagination.selectedRows",
            {
              totalCount: table.getFilteredRowModel().rows.length,
            },
            table.getFilteredSelectedRowModel().rows.length,
          )}
        </div>
      )}
      <div className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:ml-auto sm:w-auto sm:justify-end sm:gap-x-6 lg:gap-x-8">
        <div className="flex items-center space-x-2">
          <p className="whitespace-nowrap font-medium text-sm">
            {t("dataTable.pagination.rowsPerPage")}
          </p>
          <Select
            value={`${table.getState().pagination.pageSize}`}
            onValueChange={(value) => {
              table.setPageSize(Number(value));
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("dataTable.pagination.rowsPerPage")}
              className="w-auto min-w-18 border-input"
            >
              <SelectValue>
                <FormattedInteger
                  value={table.getState().pagination.pageSize}
                />
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="top">
              <SelectGroup>
                {pageSizeOptions.map((pageSize) => (
                  <SelectItem key={pageSize} value={`${pageSize}`}>
                    <FormattedInteger value={pageSize} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-center font-medium text-sm">
          {t("dataTable.pagination.page", { page: currentPage, pageCount })}
        </div>
        <div className="flex items-center space-x-2">
          <Button
            type="button"
            aria-label={t("dataTable.pagination.first")}
            variant="outline"
            size="icon"
            className="hidden size-8 border-input lg:flex"
            onClick={() => {
              table.setPageIndex(0);
            }}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronsLeft />
          </Button>
          <Button
            type="button"
            aria-label={t("dataTable.pagination.previous")}
            variant="outline"
            size="icon"
            className="size-8 border-input"
            onClick={() => {
              table.previousPage();
            }}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            aria-label={t("dataTable.pagination.next")}
            variant="outline"
            size="icon"
            className="size-8 border-input"
            onClick={() => {
              table.nextPage();
            }}
            disabled={!table.getCanNextPage()}
          >
            <ChevronRight />
          </Button>
          <Button
            type="button"
            aria-label={t("dataTable.pagination.last")}
            variant="outline"
            size="icon"
            className="hidden size-8 border-input lg:flex"
            onClick={() => {
              table.setPageIndex(pageCount - 1);
            }}
            disabled={!table.getCanNextPage()}
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
