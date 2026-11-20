import type { Column } from "@tanstack/react-table";
import { X } from "lucide-react";
import * as React from "react";

import { useLocaleFormatting } from "@dads-framework/copy";
import { Button } from "../../../elements/index.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../forms/index.js";
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
import {
  getDefaultFilterOperator,
  getFilterOperators,
} from "../../lib/data-table.js";
import type {
  ExtendedColumnFilter,
  FilterOperator,
} from "../../lib/data-table-types.js";
import { isKnownColumnId } from "../../lib/parsers.js";

import { renderFilterMenuInput } from "./data-table-filter-menu-input.js";
import {
  REMOVE_FILTER_SHORTCUTS,
  type FilterMenuUpdate,
} from "./data-table-filter-input-shared.js";

type DataTableFilterItemProps<TData> = {
  filter: ExtendedColumnFilter<TData>;
  filterItemId: string;
  columns: Column<TData>[];
  onFilterUpdate: FilterMenuUpdate<TData>;
  onFilterRemove: (filterId: string) => void;
};

export function DataTableFilterItem<TData>({
  filter,
  filterItemId,
  columns,
  onFilterUpdate,
  onFilterRemove,
}: DataTableFilterItemProps<TData>) {
  const t = useDataTableCopy();
  const formatting = useLocaleFormatting();
  const [showFieldSelector, setShowFieldSelector] = React.useState(false);
  const [showOperatorSelector, setShowOperatorSelector] = React.useState(false);
  const [showValueSelector, setShowValueSelector] = React.useState(false);

  const column = columns.find((column) => column.id === filter.id);
  const columnIds = React.useMemo(
    () => new Set(columns.map((column) => column.id)),
    [columns],
  );

  const operatorListboxId = `${filterItemId}-operator-listbox`;
  const inputId = `${filterItemId}-input`;

  const columnMeta = column?.columnDef.meta;
  const filterOperators = getFilterOperators(filter.variant);
  const selectedOperator = filterOperators.find(
    (operator) => operator.value === filter.operator,
  );

  const onItemKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (showFieldSelector || showOperatorSelector || showValueSelector) {
        return;
      }

      if (REMOVE_FILTER_SHORTCUTS.includes(event.key.toLowerCase())) {
        event.preventDefault();
        onFilterRemove(filter.filterId);
      }
    },
    [
      filter.filterId,
      showFieldSelector,
      showOperatorSelector,
      showValueSelector,
      onFilterRemove,
    ],
  );

  if (!column) return null;

  return (
    <div
      key={filter.filterId}
      role="listitem"
      id={filterItemId}
      className="flex h-8 items-center rounded-md bg-background"
      onKeyDown={onItemKeyDown}
    >
      <Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="rounded-none rounded-l-md border border-input border-r-0 font-normal dark:bg-input/30"
          >
            {columnMeta?.icon && (
              <columnMeta.icon className="text-muted-foreground" />
            )}
            {columnMeta?.label ?? column.id}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-0">
          <Command loop>
            <CommandInput placeholder={t("dataTable.filter.searchFields")} />
            <CommandList>
              <CommandEmpty>{t("dataTable.state.noFields")}</CommandEmpty>
              <CommandGroup>
                {columns.map((column) => (
                  <CommandItem
                    key={column.id}
                    value={column.id}
                    data-checked={column.id === filter.id}
                    onSelect={() => {
                      if (!isKnownColumnId<TData>(column.id, columnIds)) {
                        return;
                      }

                      const variant = column.columnDef.meta?.variant ?? "text";
                      onFilterUpdate(filter.filterId, {
                        id: column.id,
                        variant,
                        operator: getDefaultFilterOperator(variant),
                        value: "",
                      });

                      setShowFieldSelector(false);
                    }}
                  >
                    {column.columnDef.meta?.icon && (
                      <column.columnDef.meta.icon />
                    )}
                    <span className="truncate">
                      {column.columnDef.meta?.label ?? column.id}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Select
        open={showOperatorSelector}
        onOpenChange={setShowOperatorSelector}
        value={filter.operator}
        onValueChange={(value: FilterOperator) => {
          onFilterUpdate(filter.filterId, {
            operator: value,
            value:
              value === "isEmpty" || value === "isNotEmpty" ? "" : filter.value,
          });
        }}
      >
        <SelectTrigger
          size="sm"
          aria-controls={operatorListboxId}
          className="h-8 rounded-none border-r-0 px-2.5 lowercase data-size:h-8 [&_svg]:hidden"
        >
          <SelectValue
            placeholder={
              selectedOperator ? t(selectedOperator.labelKey) : filter.operator
            }
          />
        </SelectTrigger>
        <SelectContent id={operatorListboxId}>
          <SelectGroup>
            {filterOperators.map((operator) => (
              <SelectItem
                key={operator.value}
                className="lowercase"
                value={operator.value}
              >
                {t(operator.labelKey)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {renderFilterMenuInput({
        filter,
        column,
        inputId,
        onFilterUpdate,
        showValueSelector,
        setShowValueSelector,
        copy: t,
        formatting,
      })}
      <Button
        aria-controls={filterItemId}
        aria-label={t("dataTable.action.removeFilter")}
        variant="outline"
        className="h-full rounded-none rounded-r-md border border-input border-l-0 px-1.5 font-normal dark:bg-input/30"
        onClick={() => {
          onFilterRemove(filter.filterId);
        }}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
