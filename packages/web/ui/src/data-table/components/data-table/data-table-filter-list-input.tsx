import type { Option } from "../../lib/data-table-types.js";
import * as React from "react";

import { FormattedInteger } from "../../../copy/index.js";
import { Button } from "../../../elements/index.js";
import {
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../forms/index.js";

import {
  Faceted,
  FacetedBadgeList,
  FacetedContent,
  FacetedEmpty,
  FacetedGroup,
  FacetedInput,
  FacetedItem,
  FacetedList,
  FacetedTrigger,
} from "../ui/faceted.js";
import { DataTableRangeFilter } from "./data-table-range-filter.js";

import { renderFilterDateInput } from "./data-table-filter-date-input.js";
import {
  isValuelessOperator,
  type FilterMenuInputProps,
} from "./data-table-filter-input-shared.js";

export function renderFilterListInput<TData>(
  props: FilterMenuInputProps<TData>,
): React.ReactNode {
  if (isValuelessOperator(props.filter.operator)) {
    return renderEmptyStatus(props);
  }

  switch (props.filter.variant) {
    case "text":
    case "number":
    case "range":
      return renderTextInput(props);
    case "boolean":
      return renderBooleanInput(props);
    case "select":
    case "multiSelect":
      return renderOptionsInput(props);
    case "date":
    case "dateRange":
      return renderFilterDateInput(props, "list");
  }
}

function renderEmptyStatus<TData>({
  filter,
  column,
  inputId,
  copy,
}: FilterMenuInputProps<TData>) {
  const columnMeta = column.columnDef.meta;
  return (
    <div
      id={inputId}
      role="status"
      aria-label={copy(
        filter.operator === "isEmpty"
          ? "dataTable.filter.namedEmpty"
          : "dataTable.filter.namedNotEmpty",
        { columnLabel: String(columnMeta?.label) },
      )}
      aria-live="polite"
      className="h-8 w-full rounded border bg-transparent dark:bg-input/30"
    />
  );
}

function renderTextInput<TData>({
  filter,
  column,
  inputId,
  copy,
  onFilterUpdate,
}: FilterMenuInputProps<TData>) {
  const columnMeta = column.columnDef.meta;

  if (filter.operator === "isBetween") {
    return (
      <DataTableRangeFilter
        filter={filter}
        column={column}
        inputId={inputId}
        onFilterUpdate={onFilterUpdate}
      />
    );
  }

  const isNumber = filter.variant === "number" || filter.variant === "range";

  return (
    <Input
      size="sm"
      id={inputId}
      type={isNumber ? "number" : "text"}
      aria-label={copy("dataTable.filter.namedValue", {
        columnLabel: String(columnMeta?.label),
      })}
      aria-describedby={`${inputId}-description`}
      {...(isNumber ? { inputMode: "numeric" } : {})}
      placeholder={
        columnMeta?.placeholder ?? copy("dataTable.filter.enterAValue")
      }
      className="h-8 w-full rounded"
      defaultValue={typeof filter.value === "string" ? filter.value : undefined}
      onChange={(event) => {
        onFilterUpdate(filter.filterId, {
          value: event.target.value,
        });
      }}
    />
  );
}

function renderBooleanInput<TData>({
  filter,
  column,
  inputId,
  copy,
  onFilterUpdate,
  showValueSelector,
  setShowValueSelector,
}: FilterMenuInputProps<TData>) {
  const columnMeta = column.columnDef.meta;

  if (Array.isArray(filter.value)) return null;

  const inputListboxId = `${inputId}-listbox`;

  return (
    <Select
      open={showValueSelector}
      onOpenChange={setShowValueSelector}
      value={filter.value}
      onValueChange={(value) => {
        onFilterUpdate(filter.filterId, {
          value,
        });
      }}
    >
      <SelectTrigger
        size="sm"
        id={inputId}
        aria-controls={inputListboxId}
        aria-label={copy("dataTable.filter.namedBoolean", {
          columnLabel: String(columnMeta?.label),
        })}
        className="w-full rounded"
      >
        <SelectValue
          placeholder={copy(
            filter.value ? "dataTable.filter.true" : "dataTable.filter.false",
          )}
        />
      </SelectTrigger>
      <SelectContent id={inputListboxId}>
        <SelectGroup>
          <SelectItem value="true">{copy("dataTable.filter.true")}</SelectItem>
          <SelectItem value="false">
            {copy("dataTable.filter.false")}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function renderOptionsInput<TData>({
  filter,
  column,
  inputId,
  copy,
  onFilterUpdate,
  showValueSelector,
  setShowValueSelector,
}: FilterMenuInputProps<TData>) {
  const columnMeta = column.columnDef.meta;
  const options = columnMeta?.options ?? [];

  const inputListboxId = `${inputId}-listbox`;

  const multiple = filter.variant === "multiSelect";
  const selectedValues = getFacetedValue(filter.value, multiple);
  const columnLabel = String(columnMeta?.label);
  const searchPlaceholder =
    columnMeta?.placeholder ?? copy("dataTable.filter.searchOptions");
  const placeholder =
    columnMeta?.placeholder ??
    copy(
      multiple
        ? "dataTable.filter.selectOptions"
        : "dataTable.filter.selectOption",
    );

  return (
    <Faceted
      open={showValueSelector}
      onOpenChange={setShowValueSelector}
      value={selectedValues}
      onValueChange={(value) => {
        onFilterUpdate(filter.filterId, {
          value: value ?? "",
        });
      }}
      multiple={multiple}
    >
      <FacetedTrigger asChild>
        <Button
          id={inputId}
          aria-controls={inputListboxId}
          aria-label={copy(
            multiple
              ? "dataTable.filter.namedValues"
              : "dataTable.filter.namedValue",
            { columnLabel },
          )}
          variant="outline"
          className="w-full rounded font-normal"
        >
          <FacetedBadgeList options={options} placeholder={placeholder} />
        </Button>
      </FacetedTrigger>
      <FacetedContent id={inputListboxId} className="w-[200px]">
        <FacetedInput
          aria-label={copy("dataTable.filter.searchNamedOptions", {
            columnLabel,
          })}
          placeholder={searchPlaceholder}
        />
        <FacetedList>
          <FacetedEmpty>{copy("dataTable.state.noOptions")}</FacetedEmpty>
          <FacetedGroup>{options.map(renderFacetedOption)}</FacetedGroup>
        </FacetedList>
      </FacetedContent>
    </Faceted>
  );
}

function getFacetedValue(value: string | string[], multiple: boolean) {
  if (multiple) return Array.isArray(value) ? value : [];
  return typeof value === "string" ? value : [];
}

function renderFacetedOption(option: Option) {
  return (
    <FacetedItem key={option.value} value={option.value}>
      {option.icon && <option.icon />}
      <span>{option.label}</span>
      {option.count && (
        <span className="ml-auto font-mono text-xs">
          <FormattedInteger value={option.count} />
        </span>
      )}
    </FacetedItem>
  );
}
