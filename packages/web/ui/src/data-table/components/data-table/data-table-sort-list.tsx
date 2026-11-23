import type { ColumnSort, Table } from "@tanstack/react-table";
import { ArrowDownUp } from "lucide-react";
import * as React from "react";

import { FormattedInteger } from "../../../copy/index.js";
import { Badge, Button, cn } from "../../../elements/index.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { Sortable, SortableContent, SortableOverlay } from "../ui/sortable.js";

import { DataTableSortItem } from "./data-table-sort-item.js";

const SORT_SHORTCUT_KEY = "s";
const REMOVE_SORT_SHORTCUTS = ["backspace", "delete"];

type DataTableSortListProps<TData> = React.ComponentProps<typeof PopoverContent> & {
  table: Table<TData>;
  disabled?: boolean;
};

export function DataTableSortList<TData>({ table, disabled, className, ...props }: DataTableSortListProps<TData>) {
  const t = useDataTableCopy();
  const id = React.useId();
  const labelId = React.useId();
  const descriptionId = React.useId();
  const [open, setOpen] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);

  const sorting = table.getState().sorting;
  const onSortingChange = table.setSorting;

  const { columnLabels, columns } = React.useMemo(() => readSortColumns(table, sorting), [sorting, table]);

  const onSortAdd = React.useCallback(() => {
    const firstColumn = columns[0];
    if (!firstColumn) return;

    onSortingChange((prevSorting) => [...prevSorting, { id: firstColumn.id, desc: false }]);
  }, [columns, onSortingChange]);

  const onSortUpdate = React.useCallback(
    (sortId: string, updates: Partial<ColumnSort>) => {
      onSortingChange((prevSorting) => updateSort(prevSorting, sortId, updates));
    },
    [onSortingChange],
  );

  const onSortRemove = React.useCallback(
    (sortId: string) => {
      onSortingChange((prevSorting) => removeSort(prevSorting, sortId));
    },
    [onSortingChange],
  );

  const onSortingReset = React.useCallback(() => {
    onSortingChange(table.initialState.sorting);
  }, [onSortingChange, table.initialState.sorting]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.contentEditable === "true")
      ) {
        return;
      }

      if (event.key.toLowerCase() === SORT_SHORTCUT_KEY && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        event.preventDefault();
        setOpen(toggleOpen);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const onTriggerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (REMOVE_SORT_SHORTCUTS.includes(event.key.toLowerCase()) && sorting.length > 0) {
        event.preventDefault();
        onSortingReset();
      }
    },
    [sorting.length, onSortingReset],
  );

  return (
    <Sortable value={sorting} onValueChange={onSortingChange} getItemValue={(item) => item.id}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="font-normal" onKeyDown={onTriggerKeyDown} disabled={disabled}>
            <ArrowDownUp className="text-muted-foreground" />
            {t("dataTable.sort.trigger")}
            {sorting.length > 0 && (
              <Badge
                variant="secondary"
                className="h-[18.24px] rounded-[3.2px] px-[5.12px] font-mono font-normal text-[10.4px]"
              >
                <FormattedInteger value={sorting.length} />
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className={cn(
            "flex w-full max-w-(--radix-popover-content-available-width) flex-col gap-3.5 p-4 sm:min-w-[380px]",
            className,
          )}
          {...props}
        >
          <div className="flex flex-col gap-1">
            <h4 id={labelId} className="font-medium leading-none">
              {sorting.length > 0 ? t("dataTable.sort.heading.active") : t("dataTable.sort.heading.empty")}
            </h4>
            <p id={descriptionId} className={cn("text-muted-foreground text-sm", sorting.length > 0 && "sr-only")}>
              {sorting.length > 0 ? t("dataTable.sort.description.active") : t("dataTable.sort.description.empty")}
            </p>
          </div>
          {sorting.length > 0 && (
            <SortableContent asChild>
              <div role="list" className="flex max-h-[300px] flex-col gap-2 overflow-y-auto p-1">
                {sorting.map((sort) => (
                  <DataTableSortItem
                    key={sort.id}
                    sort={sort}
                    sortItemId={`${id}-sort-${sort.id}`}
                    columns={columns}
                    columnLabels={columnLabels}
                    onSortUpdate={onSortUpdate}
                    onSortRemove={onSortRemove}
                  />
                ))}
              </div>
            </SortableContent>
          )}
          <div className="flex w-full items-center gap-2">
            <Button className="rounded" ref={addButtonRef} onClick={onSortAdd} disabled={columns.length === 0}>
              {t("dataTable.action.addSort")}
            </Button>
            {sorting.length > 0 && (
              <Button variant="outline" className="rounded" onClick={onSortingReset}>
                {t("dataTable.action.resetSorting")}
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <SortableOverlay>
        <div className="flex items-center gap-2">
          <div className="h-8 w-[180px] rounded-sm bg-primary/10" />
          <div className="h-8 w-24 rounded-sm bg-primary/10" />
          <div className="size-8 shrink-0 rounded-sm bg-primary/10" />
          <div className="size-8 shrink-0 rounded-sm bg-primary/10" />
        </div>
      </SortableOverlay>
    </Sortable>
  );
}

function readSortColumns<TData>(table: Table<TData>, sorting: ColumnSort[]) {
  const columnLabels = new Map<string, string>();
  const sortingIds = new Set(sorting.map((sort) => sort.id));
  const columns: { id: string; label: string }[] = [];

  for (const column of table.getAllColumns()) {
    if (!column.getCanSort()) continue;
    const label = column.columnDef.meta?.label ?? column.id;
    columnLabels.set(column.id, label);
    if (!sortingIds.has(column.id)) columns.push({ id: column.id, label });
  }

  return { columnLabels, columns };
}

function toggleOpen(open: boolean): boolean {
  return !open;
}

function updateSort(sorting: ColumnSort[], id: string, updates: Partial<ColumnSort>) {
  return sorting.map((sort) => (sort.id === id ? { ...sort, ...updates } : sort));
}

function removeSort(sorting: ColumnSort[], id: string) {
  return sorting.filter((sort) => sort.id !== id);
}
