import type { Column } from "@tanstack/react-table";
import { Check, PlusCircle, XCircle } from "lucide-react";
import * as React from "react";

import { FormattedInteger } from "@dads-framework/copy";
import { StatusBadge } from "../../../display/index.js";
import { Badge, Button, cn, Separator } from "../../../elements/index.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import type { Option } from "../../lib/data-table-types.js";

type DataTableFacetedFilterProps<TData, TValue> = {
  column?: Column<TData, TValue>;
  title?: string;
  options: Option[];
  multiple?: boolean;
  canClear?: boolean;
};

export function DataTableFacetedFilter<TData, TValue>({
  column,
  title,
  options,
  multiple,
  canClear = true,
}: DataTableFacetedFilterProps<TData, TValue>) {
  const t = useDataTableCopy();
  const [open, setOpen] = React.useState(false);

  const columnFilterValue = column?.getFilterValue();
  const selectedValues = new Set(
    Array.isArray(columnFilterValue)
      ? columnFilterValue.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const clearLabel = title
    ? t("dataTable.action.clearNamedFilter", { columnLabel: title })
    : t("dataTable.action.clearFilter");

  const onItemSelect = React.useCallback(
    (option: Option, isSelected: boolean) => {
      if (!column) return;

      if (multiple) {
        const newSelectedValues = new Set(selectedValues);
        if (isSelected) {
          newSelectedValues.delete(option.value);
        } else {
          newSelectedValues.add(option.value);
        }
        const filterValues = Array.from(newSelectedValues);
        column.setFilterValue(filterValues.length ? filterValues : undefined);
      } else {
        if (!isSelected) {
          column.setFilterValue([option.value]);
        } else if (canClear) {
          column.setFilterValue(undefined);
        }
        setOpen(false);
      }
    },
    [canClear, column, multiple, selectedValues],
  );

  const onReset = React.useCallback(() => {
    column?.setFilterValue(undefined);
  }, [column]);

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-input border-dashed font-normal"
          >
            <PlusCircle />
            {title}
            <FacetedFilterSelection
              options={options}
              selectedValues={selectedValues}
              multiple={multiple === true}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-50 p-0" align="start">
          <Command>
            <CommandInput placeholder={title} />
            <CommandList className="max-h-full">
              <CommandEmpty>
                {t("dataTable.state.noFilterResults")}
              </CommandEmpty>
              <CommandGroup className="max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden">
                {options.map((option) => {
                  const isSelected = selectedValues.has(option.value);

                  return (
                    <CommandItem
                      key={option.value}
                      onSelect={() => {
                        onItemSelect(option, isSelected);
                      }}
                    >
                      {multiple ? (
                        <div
                          data-slot="data-table-multi-select-checkbox"
                          className={cn(
                            "flex size-4 items-center justify-center rounded-sm border border-primary",
                            isSelected
                              ? "bg-primary text-primary-foreground"
                              : "opacity-50 [&_svg]:invisible",
                          )}
                        >
                          <Check />
                        </div>
                      ) : null}
                      {option.icon && <option.icon />}
                      <FilterOption option={option} />
                      {option.count && (
                        <span className="ml-auto font-mono text-xs">
                          <FormattedInteger value={option.count} />
                        </span>
                      )}
                      {!multiple && isSelected ? (
                        <Check
                          data-slot="data-table-single-select-indicator"
                          className="ml-auto"
                        />
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {canClear && selectedValues.size > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={onReset}
                      className="justify-center text-center"
                    >
                      {t("dataTable.action.clearFilters")}
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {canClear && selectedValues.size > 0 && (
        <Button
          type="button"
          aria-label={clearLabel}
          variant="outline"
          size="icon-sm"
          className="border-input border-dashed"
          onClick={onReset}
        >
          <XCircle />
        </Button>
      )}
    </div>
  );
}

function selectedOptions(
  options: Option[],
  selectedValues: ReadonlySet<string>,
) {
  return options
    .filter((option) => selectedValues.has(option.value))
    .map((option) => <SelectedOption key={option.value} option={option} />);
}

function SelectedOption({ option }: { readonly option: Option }) {
  if (option.badgeTone) {
    return <StatusBadge tone={option.badgeTone}>{option.label}</StatusBadge>;
  }
  return (
    <Badge variant="secondary" className="rounded-sm px-1 font-normal">
      {option.label}
    </Badge>
  );
}

function FilterOption({ option }: { readonly option: Option }) {
  if (option.badgeTone) {
    return <StatusBadge tone={option.badgeTone}>{option.label}</StatusBadge>;
  }
  return <span className="truncate">{option.label}</span>;
}

function FacetedFilterSelection({
  options,
  selectedValues,
  multiple,
}: {
  options: Option[];
  selectedValues: ReadonlySet<string>;
  multiple: boolean;
}) {
  const t = useDataTableCopy();
  if (selectedValues.size === 0) return null;

  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-0.5 data-[orientation=vertical]:h-4"
      />
      {multiple ? (
        <>
          <Badge
            variant="secondary"
            className="rounded-sm px-1 font-normal lg:hidden"
          >
            {selectedValues.size}
          </Badge>
          <div className="hidden items-center gap-1 lg:flex">
            {selectedValues.size > 2 ? (
              <Badge
                variant="secondary"
                className="rounded-sm px-1 font-normal"
              >
                {t("dataTable.filter.selectedCount", {
                  count: selectedValues.size,
                })}
              </Badge>
            ) : (
              selectedOptions(options, selectedValues)
            )}
          </div>
        </>
      ) : (
        selectedOptions(options, selectedValues)
      )}
    </>
  );
}
