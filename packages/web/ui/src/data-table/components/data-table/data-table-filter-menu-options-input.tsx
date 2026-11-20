import { Button } from "../../../elements/index.js";
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
import type { FilterMenuInputProps } from "./data-table-filter-input-shared.js";

export function renderFilterMenuOptionsInput<TData>({
  filter,
  column,
  inputId,
  onFilterUpdate,
  showValueSelector,
  setShowValueSelector,
  copy,
}: FilterMenuInputProps<TData>) {
  const inputListboxId = `${inputId}-listbox`;

  const options = column.columnDef.meta?.options ?? [];
  const selectedValues = Array.isArray(filter.value)
    ? filter.value
    : [filter.value];

  const selectedOptions = options.filter((option) =>
    selectedValues.includes(option.value),
  );

  return (
    <Popover open={showValueSelector} onOpenChange={setShowValueSelector}>
      <PopoverTrigger asChild>
        <Button
          id={inputId}
          aria-controls={inputListboxId}
          variant="outline"
          className="h-full min-w-16 rounded-none border border-input px-1.5 font-normal dark:bg-input/30"
        >
          {selectedOptions.length === 0 ? (
            filter.variant === "multiSelect" ? (
              copy("dataTable.filter.selectOptions")
            ) : (
              copy("dataTable.filter.selectOption")
            )
          ) : (
            <>
              <div className="flex items-center -space-x-2 rtl:space-x-reverse">
                {selectedOptions.map((selectedOption) =>
                  selectedOption.icon ? (
                    <div
                      key={selectedOption.value}
                      className="rounded-full border bg-background p-0.5"
                    >
                      <selectedOption.icon className="size-3.5" />
                    </div>
                  ) : null,
                )}
              </div>
              <span className="truncate">
                {selectedOptions.length > 1
                  ? copy("dataTable.filter.selectedCount", {
                      count: selectedOptions.length,
                    })
                  : selectedOptions[0]?.label}
              </span>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent id={inputListboxId} align="start" className="w-48 p-0">
        <Command>
          <CommandInput placeholder={copy("dataTable.filter.searchOptions")} />
          <CommandList>
            <CommandEmpty>{copy("dataTable.state.noOptions")}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isMultiSelect = filter.variant === "multiSelect";
                const isSelected = selectedValues.includes(option.value);

                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    data-checked={isMultiSelect ? isSelected : undefined}
                    onSelect={() => {
                      const value = isMultiSelect
                        ? isSelected
                          ? selectedValues.filter((v) => v !== option.value)
                          : [...selectedValues, option.value]
                        : option.value;
                      onFilterUpdate(filter.filterId, { value });
                    }}
                  >
                    {option.icon && <option.icon />}
                    <span className="truncate">{option.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
