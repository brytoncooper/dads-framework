import type { Table } from "@tanstack/react-table";
import { ListFilter } from "lucide-react";
import * as React from "react";

import { FormattedInteger } from "@dads-framework/copy";
import { Badge, Button, cn } from "../../../elements/index.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { useDebouncedCallback } from "../../hooks/use-debounced-callback.js";
import { getDefaultFilterOperator } from "../../lib/data-table.js";
import { readDataTableFilterState } from "../../lib/data-table.js";
import type { ExtendedColumnFilter } from "../../lib/data-table-types.js";
import { generateId } from "../../lib/id.js";
import { isKnownColumnId } from "../../lib/parsers.js";
import { Sortable, SortableContent, SortableOverlay } from "../ui/sortable.js";

import { DataTableFilterItem } from "./data-table-filter-list-item.js";

import { REMOVE_FILTER_SHORTCUTS } from "./data-table-filter-input-shared.js";

const DEBOUNCE_MS = 300;
const FILTER_SHORTCUT_KEY = "f";

type DataTableFilterListProps<TData> = React.ComponentProps<
  typeof PopoverContent
> & {
  table: Table<TData>;
  debounceMs?: number;
  disabled?: boolean;
};

export function DataTableFilterList<TData>({
  table,
  debounceMs = DEBOUNCE_MS,
  disabled,
  ...props
}: DataTableFilterListProps<TData>) {
  const t = useDataTableCopy();
  const id = React.useId();
  const labelId = React.useId();
  const descriptionId = React.useId();
  const [open, setOpen] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);

  const {
    filters,
    onFiltersChange,
    joinOperator,
    onJoinOperatorChange: setJoinOperator,
  } = readDataTableFilterState(table);

  const columns = React.useMemo(() => {
    return table
      .getAllColumns()
      .filter((column) => column.columnDef.enableColumnFilter);
  }, [table]);

  const columnIds = React.useMemo(
    () => new Set(columns.map((column) => column.id)),
    [columns],
  );

  const debouncedSetFilters = useDebouncedCallback(onFiltersChange, debounceMs);

  const onFilterAdd = React.useCallback(() => {
    const column = columns[0];

    if (!column || !isKnownColumnId<TData>(column.id, columnIds)) return;

    const variant = column.columnDef.meta?.variant ?? "text";
    debouncedSetFilters([
      ...filters,
      {
        id: column.id,
        value: "",
        variant,
        operator: getDefaultFilterOperator(variant),
        filterId: generateId({ length: 8 }),
      },
    ]);
  }, [columns, columnIds, filters, debouncedSetFilters]);

  const onFilterUpdate = React.useCallback(
    (
      filterId: string,
      updates: Partial<Omit<ExtendedColumnFilter<TData>, "filterId">>,
    ) => {
      debouncedSetFilters(
        filters.map((filter) =>
          filter.filterId === filterId ? { ...filter, ...updates } : filter,
        ),
      );
    },
    [filters, debouncedSetFilters],
  );

  const onFilterRemove = React.useCallback(
    (filterId: string) => {
      onFiltersChange(filters.filter((filter) => filter.filterId !== filterId));
      requestAnimationFrame(() => {
        addButtonRef.current?.focus();
      });
    },
    [filters, onFiltersChange],
  );

  const onFiltersReset = React.useCallback(() => {
    onFiltersChange([]);
    setJoinOperator("and");
  }, [onFiltersChange, setJoinOperator]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement &&
          event.target.contentEditable === "true")
      ) {
        return;
      }

      if (
        event.key.toLowerCase() === FILTER_SHORTCUT_KEY &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const onTriggerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        REMOVE_FILTER_SHORTCUTS.includes(event.key.toLowerCase()) &&
        filters.length > 0
      ) {
        event.preventDefault();
        onFilterRemove(filters[filters.length - 1]?.filterId ?? "");
      }
    },
    [filters, onFilterRemove],
  );

  return (
    <Sortable
      value={filters}
      onValueChange={onFiltersChange}
      getItemValue={(item) => item.filterId}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="font-normal"
            onKeyDown={onTriggerKeyDown}
            disabled={disabled}
          >
            <ListFilter className="text-muted-foreground" />
            {t("dataTable.filter.trigger")}
            {filters.length > 0 && (
              <Badge
                variant="secondary"
                className="h-[18.24px] rounded-[3.2px] px-[5.12px] font-mono font-normal text-[10.4px]"
              >
                <FormattedInteger value={filters.length} />
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-describedby={descriptionId}
          aria-labelledby={labelId}
          className="flex w-full max-w-(--radix-popover-content-available-width) flex-col gap-3.5 p-4 sm:min-w-[380px]"
          {...props}
        >
          <div className="flex flex-col gap-1">
            <h4 id={labelId} className="font-medium leading-none">
              {filters.length > 0
                ? t("dataTable.filter.heading.active")
                : t("dataTable.filter.heading.empty")}
            </h4>
            <p
              id={descriptionId}
              className={cn(
                "text-muted-foreground text-sm",
                filters.length > 0 && "sr-only",
              )}
            >
              {filters.length > 0
                ? t("dataTable.filter.description.active")
                : t("dataTable.filter.description.empty")}
            </p>
          </div>
          {filters.length > 0 ? (
            <SortableContent asChild>
              <div
                role="list"
                className="flex max-h-[300px] flex-col gap-2 overflow-y-auto p-1"
              >
                {filters.map((filter, index) => (
                  <DataTableFilterItem<TData>
                    key={filter.filterId}
                    filter={filter}
                    index={index}
                    filterItemId={`${id}-filter-${filter.filterId}`}
                    joinOperator={joinOperator}
                    setJoinOperator={setJoinOperator}
                    columns={columns}
                    onFilterUpdate={onFilterUpdate}
                    onFilterRemove={onFilterRemove}
                  />
                ))}
              </div>
            </SortableContent>
          ) : null}
          <div className="flex w-full items-center gap-2">
            <Button
              className="rounded"
              ref={addButtonRef}
              onClick={onFilterAdd}
            >
              {t("dataTable.action.addFilter")}
            </Button>
            {filters.length > 0 ? (
              <Button
                variant="outline"
                className="rounded"
                onClick={onFiltersReset}
              >
                {t("dataTable.action.resetFilters")}
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      <SortableOverlay>
        <div className="flex items-center gap-2">
          <div className="h-8 min-w-[72px] rounded-sm bg-primary/10" />
          <div className="h-8 w-32 rounded-sm bg-primary/10" />
          <div className="h-8 w-32 rounded-sm bg-primary/10" />
          <div className="h-8 min-w-36 flex-1 rounded-sm bg-primary/10" />
          <div className="size-8 shrink-0 rounded-sm bg-primary/10" />
          <div className="size-8 shrink-0 rounded-sm bg-primary/10" />
        </div>
      </SortableOverlay>
    </Sortable>
  );
}
