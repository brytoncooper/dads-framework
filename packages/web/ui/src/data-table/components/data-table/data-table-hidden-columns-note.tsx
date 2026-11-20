import type { Table } from "@tanstack/react-table";

import { Button } from "../../../elements/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import {
  countReaderHiddenColumns,
  showAllColumns,
} from "../../lib/reader-hidden-columns.js";

/**
 * A quiet line under the toolbar while the reader has hidden any column, so
 * hidden data is never out of sight and always one tap from coming back.
 */
export function DataTableHiddenColumnsNote<TData>({
  table,
}: {
  readonly table: Table<TData>;
}) {
  const t = useDataTableCopy();
  const hiddenCount = countReaderHiddenColumns(table);
  if (hiddenCount === 0) return null;

  return (
    <div
      data-slot="data-table-hidden-columns"
      className="flex flex-wrap items-center gap-2 px-1 text-foreground text-sm"
    >
      <span>{t("dataTable.columns.hiddenCount", {}, hiddenCount)}</span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => {
          showAllColumns(table);
        }}
      >
        {t("dataTable.action.showAllColumns")}
      </Button>
    </div>
  );
}
