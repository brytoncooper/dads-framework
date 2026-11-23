import type * as React from "react";

import {
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../forms/index.js";

import { renderFilterDateInput } from "./data-table-filter-date-input.js";
import { renderFilterMenuOptionsInput } from "./data-table-filter-menu-options-input.js";
import { isValuelessOperator, type FilterMenuInputProps } from "./data-table-filter-input-shared.js";
import { DataTableRangeFilter } from "./data-table-range-filter.js";

/** The value input for one applied filter, chosen by operator and variant. */
export function renderFilterMenuInput<TData>(props: FilterMenuInputProps<TData>): React.ReactNode {
  if (isValuelessOperator(props.filter.operator)) {
    return renderFilterMenuEmptyStatus(props);
  }

  switch (props.filter.variant) {
    case "text":
    case "number":
    case "range":
      return renderFilterMenuTextInput(props);
    case "boolean":
      return renderFilterMenuBooleanInput(props);
    case "select":
    case "multiSelect":
      return renderFilterMenuOptionsInput(props);
    case "date":
    case "dateRange":
      return renderFilterDateInput(props, "menu");
  }
}

function renderFilterMenuEmptyStatus<TData>({ filter, column, inputId, copy }: FilterMenuInputProps<TData>) {
  return (
    <div
      id={inputId}
      role="status"
      aria-label={copy(
        filter.operator === "isEmpty" ? "dataTable.filter.namedEmpty" : "dataTable.filter.namedNotEmpty",
        { columnLabel: String(column.columnDef.meta?.label) },
      )}
      aria-live="polite"
      className="h-full w-16 rounded-none border border-input bg-transparent px-1.5 py-0.5 text-muted-foreground dark:bg-input/30"
    />
  );
}

function renderFilterMenuTextInput<TData>({
  filter,
  column,
  inputId,
  onFilterUpdate,
  copy,
}: FilterMenuInputProps<TData>) {
  if (filter.operator === "isBetween") {
    return (
      <DataTableRangeFilter
        filter={filter}
        column={column}
        inputId={inputId}
        onFilterUpdate={onFilterUpdate}
        className="size-full max-w-28 gap-0 **:data-[slot='range-min']:border-r-0 [&_input]:rounded-none [&_input]:px-1.5"
      />
    );
  }

  const isNumber = filter.variant === "number" || filter.variant === "range";

  return (
    <Input
      size="sm"
      id={inputId}
      type={isNumber ? "number" : "text"}
      {...(isNumber ? { inputMode: "numeric" } : {})}
      placeholder={column.columnDef.meta?.placeholder ?? copy("dataTable.filter.enterValue")}
      className="h-full w-24 rounded-none px-1.5"
      defaultValue={typeof filter.value === "string" ? filter.value : ""}
      onChange={(event) => {
        onFilterUpdate(filter.filterId, { value: event.target.value });
      }}
    />
  );
}

function renderFilterMenuBooleanInput<TData>({
  filter,
  inputId,
  onFilterUpdate,
  showValueSelector,
  setShowValueSelector,
  copy,
}: FilterMenuInputProps<TData>) {
  const inputListboxId = `${inputId}-listbox`;

  return (
    <Select
      open={showValueSelector}
      onOpenChange={setShowValueSelector}
      value={typeof filter.value === "string" ? filter.value : "true"}
      onValueChange={(value: "true" | "false") => {
        onFilterUpdate(filter.filterId, { value });
      }}
    >
      <SelectTrigger
        size="sm"
        id={inputId}
        aria-controls={inputListboxId}
        className="rounded-none bg-transparent px-1.5 py-0.5 [&_svg]:hidden"
      >
        <SelectValue placeholder={copy(filter.value ? "dataTable.filter.true" : "dataTable.filter.false")} />
      </SelectTrigger>
      <SelectContent id={inputListboxId}>
        <SelectGroup>
          <SelectItem value="true">{copy("dataTable.filter.true")}</SelectItem>
          <SelectItem value="false">{copy("dataTable.filter.false")}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
