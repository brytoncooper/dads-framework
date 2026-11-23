import type { Column, Table } from "@tanstack/react-table";
import { ListFilter, X } from "lucide-react";
import * as React from "react";

import { Button, cn } from "../../../elements/index.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
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

import { DataTableFilterItem } from "./data-table-filter-menu-item.js";
import { FilterValueSelector } from "./data-table-filter-menu-value-selector.js";

import { REMOVE_FILTER_SHORTCUTS } from "./data-table-filter-input-shared.js";

const DEBOUNCE_MS = 300;
const FILTER_SHORTCUT_KEY = "f";

type DataTableFilterMenuProps<TData> = React.ComponentProps<typeof PopoverContent> & {
  table: Table<TData>;
  debounceMs?: number;
  disabled?: boolean;
};

export function DataTableFilterMenu<TData>({
  table,
  debounceMs = DEBOUNCE_MS,
  disabled,
  className,
  ...props
}: DataTableFilterMenuProps<TData>) {
  const t = useDataTableCopy();
  const id = React.useId();

  const { filters, onFiltersChange } = readDataTableFilterState(table);

  const columns = React.useMemo(() => {
    return table.getAllColumns().filter((column) => column.columnDef.enableColumnFilter);
  }, [table]);

  const columnIds = React.useMemo(() => new Set(columns.map((column) => column.id)), [columns]);

  const [open, setOpen] = React.useState(false);
  const [selectedColumn, setSelectedColumn] = React.useState<Column<TData> | null>(null);
  const [inputValue, setInputValue] = React.useState("");
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onOpenChange = React.useCallback((open: boolean) => {
    setOpen(open);

    if (!open) {
      setTimeout(() => {
        setSelectedColumn(null);
        setInputValue("");
      }, 100);
    }
  }, []);

  const onInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (REMOVE_FILTER_SHORTCUTS.includes(event.key.toLowerCase()) && !inputValue && selectedColumn) {
        event.preventDefault();
        setSelectedColumn(null);
      }
    },
    [inputValue, selectedColumn],
  );

  const debouncedSetFilters = useDebouncedCallback(onFiltersChange, debounceMs);

  const onFilterAdd = React.useCallback(
    (column: Column<TData>, value: string) => {
      const variant = column.columnDef.meta?.variant ?? "text";
      if (!value.trim() && variant !== "boolean") return;
      if (!isKnownColumnId<TData>(column.id, columnIds)) return;

      const newFilter: ExtendedColumnFilter<TData> = {
        id: column.id,
        value: variant === "multiSelect" ? [value] : value,
        variant,
        operator: getDefaultFilterOperator(variant),
        filterId: generateId({ length: 8 }),
      };

      debouncedSetFilters([...filters, newFilter]);
      setOpen(false);

      setTimeout(() => {
        setSelectedColumn(null);
        setInputValue("");
      }, 100);
    },
    [columnIds, filters, debouncedSetFilters],
  );

  const onFilterRemove = React.useCallback(
    (filterId: string) => {
      debouncedSetFilters(filters.filter((filter) => filter.filterId !== filterId));
      requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    },
    [filters, debouncedSetFilters],
  );

  const onFilterUpdate = React.useCallback(
    (filterId: string, updates: Partial<Omit<ExtendedColumnFilter<TData>, "filterId">>) => {
      debouncedSetFilters(filters.map((filter) => (filter.filterId === filterId ? { ...filter, ...updates } : filter)));
    },
    [filters, debouncedSetFilters],
  );

  const onFiltersReset = React.useCallback(() => {
    debouncedSetFilters([]);
  }, [debouncedSetFilters]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.contentEditable === "true")
      ) {
        return;
      }

      if (event.key.toLowerCase() === FILTER_SHORTCUT_KEY && (event.ctrlKey || event.metaKey) && event.shiftKey) {
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
      if (REMOVE_FILTER_SHORTCUTS.includes(event.key.toLowerCase()) && filters.length > 0) {
        event.preventDefault();
        onFilterRemove(filters[filters.length - 1]?.filterId ?? "");
      }
    },
    [filters, onFilterRemove],
  );

  return (
    <div role="list" className="flex flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <DataTableFilterItem
          key={filter.filterId}
          filter={filter}
          filterItemId={`${id}-filter-${filter.filterId}`}
          columns={columns}
          onFilterUpdate={onFilterUpdate}
          onFilterRemove={onFilterRemove}
        />
      ))}
      {filters.length > 0 && (
        <Button
          aria-label={t("dataTable.action.resetAllFilters")}
          variant="outline"
          size="icon"
          className="size-8"
          onClick={onFiltersReset}
        >
          <X />
        </Button>
      )}
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            aria-label={t("dataTable.filter.openCommandMenu")}
            variant="outline"
            size={filters.length > 0 ? "icon" : "sm"}
            className={cn(filters.length > 0 && "size-8", "h-8 font-normal")}
            ref={triggerRef}
            onKeyDown={onTriggerKeyDown}
            disabled={disabled}
          >
            <ListFilter className="text-muted-foreground" />
            {filters.length > 0 ? null : t("dataTable.filter.trigger")}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className={cn("w-full max-w-(--radix-popover-content-available-width) p-0", className)}
          {...props}
        >
          <Command loop className="[&_[cmdk-input-wrapper]_svg]:hidden">
            <CommandInput
              ref={inputRef}
              placeholder={
                selectedColumn
                  ? (selectedColumn.columnDef.meta?.label ?? selectedColumn.id)
                  : t("dataTable.filter.searchFields")
              }
              value={inputValue}
              onValueChange={setInputValue}
              onKeyDown={onInputKeyDown}
            />
            <CommandList>
              <FilterMenuChoices
                selectedColumn={selectedColumn}
                columns={columns}
                inputValue={inputValue}
                onFilterSelect={onFilterAdd}
                onColumnSelect={(column) => {
                  setSelectedColumn(column);
                  setInputValue("");
                  requestAnimationFrame(() => {
                    inputRef.current?.focus();
                  });
                }}
              />
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FilterMenuChoices<TData>({
  selectedColumn,
  columns,
  inputValue,
  onFilterSelect,
  onColumnSelect,
}: {
  selectedColumn: Column<TData> | null;
  columns: readonly Column<TData>[];
  inputValue: string;
  onFilterSelect: (column: Column<TData>, value: string) => void;
  onColumnSelect: (column: Column<TData>) => void;
}) {
  const t = useDataTableCopy();
  return selectedColumn ? (
    <>
      {selectedColumn.columnDef.meta?.options && <CommandEmpty>{t("dataTable.state.noOptions")}</CommandEmpty>}
      <FilterValueSelector
        column={selectedColumn}
        value={inputValue}
        onSelect={(value) => {
          onFilterSelect(selectedColumn, value);
        }}
      />
    </>
  ) : (
    <>
      <CommandEmpty>{t("dataTable.state.noFields")}</CommandEmpty>
      <CommandGroup>
        {columns.map((column) => (
          <CommandItem
            key={column.id}
            value={column.id}
            onSelect={() => {
              onColumnSelect(column);
            }}
          >
            {column.columnDef.meta?.icon && <column.columnDef.meta.icon />}
            <span className="truncate">{column.columnDef.meta?.label ?? column.id}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}
