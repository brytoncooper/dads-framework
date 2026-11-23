import type { Column } from "@tanstack/react-table";
import { Check, ChevronsUpDown, GripVertical, Trash2 } from "lucide-react";
import * as React from "react";

import { useLocaleFormatting } from "../../../copy/index.js";
import { Button, cn } from "../../../elements/index.js";
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

import { dataTableConfig } from "../../config/data-table.js";
import { useDataTableCopy } from "../../copy/data-table-copy.js";
import {
  getDefaultFilterOperator,
  getFilterOperators,
} from "../../lib/data-table.js";
import type {
  ExtendedColumnFilter,
  FilterOperator,
  JoinOperator,
} from "../../lib/data-table-types.js";
import { isKnownColumnId } from "../../lib/parsers.js";
import { SortableItem, SortableItemHandle } from "../ui/sortable.js";

import { renderFilterListInput } from "./data-table-filter-list-input.js";
import {
  REMOVE_FILTER_SHORTCUTS,
  type FilterMenuUpdate,
} from "./data-table-filter-input-shared.js";

type DataTableFilterItemProps<TData> = {
  filter: ExtendedColumnFilter<TData>;
  index: number;
  filterItemId: string;
  joinOperator: JoinOperator;
  setJoinOperator: (value: JoinOperator) => void;
  columns: Column<TData>[];
  onFilterUpdate: FilterMenuUpdate<TData>;
  onFilterRemove: (filterId: string) => void;
};

export function DataTableFilterItem<TData>({
  filter,
  index,
  filterItemId,
  joinOperator,
  setJoinOperator,
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

  const joinOperatorListboxId = `${filterItemId}-join-operator-listbox`;
  const fieldListboxId = `${filterItemId}-field-listbox`;
  const operatorListboxId = `${filterItemId}-operator-listbox`;
  const inputId = `${filterItemId}-input`;

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
    <SortableItem value={filter.filterId} asChild>
      <div
        role="listitem"
        id={filterItemId}
        tabIndex={-1}
        className="flex items-center gap-2"
        onKeyDown={onItemKeyDown}
      >
        <div className="min-w-[72px] text-center">
          {index === 0 ? (
            <span className="text-muted-foreground text-sm">
              {t("dataTable.filter.where")}
            </span>
          ) : index === 1 ? (
            <Select
              value={joinOperator}
              onValueChange={(value: JoinOperator) => {
                setJoinOperator(value);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("dataTable.filter.selectJoinOperator")}
                aria-controls={joinOperatorListboxId}
                className="rounded lowercase"
              >
                <SelectValue
                  placeholder={t(
                    dataTableConfig.joinOperatorLabelKeys[joinOperator],
                  )}
                />
              </SelectTrigger>
              <SelectContent
                id={joinOperatorListboxId}
                position="popper"
                className="min-w-(--radix-select-trigger-width) lowercase"
              >
                <SelectGroup>
                  {dataTableConfig.joinOperators.map((joinOperator) => (
                    <SelectItem key={joinOperator} value={joinOperator}>
                      {t(dataTableConfig.joinOperatorLabelKeys[joinOperator])}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <span className="text-muted-foreground text-sm">
              {t(dataTableConfig.joinOperatorLabelKeys[joinOperator])}
            </span>
          )}
        </div>
        <Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
          <PopoverTrigger asChild>
            <Button
              aria-controls={fieldListboxId}
              variant="outline"
              className="w-32 justify-between rounded font-normal"
            >
              <span className="truncate">
                {columns.find((column) => column.id === filter.id)?.columnDef
                  .meta?.label ?? t("dataTable.filter.selectField")}
              </span>
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            id={fieldListboxId}
            align="start"
            className="w-40 p-0"
          >
            <Command>
              <CommandInput placeholder={t("dataTable.filter.searchFields")} />
              <CommandList>
                <CommandEmpty>{t("dataTable.state.noFields")}</CommandEmpty>
                <CommandGroup>
                  {columns.map((column) => (
                    <CommandItem
                      key={column.id}
                      value={column.id}
                      onSelect={() => {
                        if (!isKnownColumnId<TData>(column.id, columnIds)) {
                          return;
                        }

                        const variant =
                          column.columnDef.meta?.variant ?? "text";
                        onFilterUpdate(filter.filterId, {
                          id: column.id,
                          variant,
                          operator: getDefaultFilterOperator(variant),
                          value: "",
                        });

                        setShowFieldSelector(false);
                      }}
                    >
                      <span className="truncate">
                        {column.columnDef.meta?.label}
                      </span>
                      <Check
                        className={cn(
                          "ml-auto",
                          column.id === filter.id ? "opacity-100" : "opacity-0",
                        )}
                      />
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
                value === "isEmpty" || value === "isNotEmpty"
                  ? ""
                  : filter.value,
            });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-controls={operatorListboxId}
            className="w-32 rounded lowercase"
          >
            <div className="truncate">
              <SelectValue
                placeholder={
                  selectedOperator
                    ? t(selectedOperator.labelKey)
                    : filter.operator
                }
              />
            </div>
          </SelectTrigger>
          <SelectContent id={operatorListboxId}>
            <SelectGroup>
              {filterOperators.map((operator) => (
                <SelectItem
                  key={operator.value}
                  value={operator.value}
                  className="lowercase"
                >
                  {t(operator.labelKey)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="min-w-36 max-w-60 flex-1">
          {renderFilterListInput({
            filter,
            inputId,
            column,
            onFilterUpdate,
            showValueSelector,
            setShowValueSelector,
            copy: t,
            formatting,
          })}
        </div>
        <Button
          aria-controls={filterItemId}
          aria-label={t("dataTable.action.removeFilter")}
          variant="outline"
          size="icon"
          className="size-8 rounded"
          onClick={() => {
            onFilterRemove(filter.filterId);
          }}
        >
          <Trash2 />
        </Button>
        <SortableItemHandle asChild>
          <Button variant="outline" size="icon" className="size-8 rounded">
            <GripVertical />
          </Button>
        </SortableItemHandle>
      </div>
    </SortableItem>
  );
}
