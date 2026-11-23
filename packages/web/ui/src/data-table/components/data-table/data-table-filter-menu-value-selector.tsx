import type { Option } from "../../lib/data-table-types.js";
import type { Column } from "@tanstack/react-table";
import { BadgeCheck, Text } from "lucide-react";

import { FormattedInteger } from "../../../copy/index.js";
import { CommandGroup, CommandItem } from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { toTimestampText } from "../../lib/format.js";
import { DatePicker } from "../ui/date-picker.js";

import { readColumnFilterVariant } from "./data-table-filter-input-shared.js";

type FilterValueSelectorProps<TData> = {
  column: Column<TData>;
  value: string;
  onSelect: (value: string) => void;
};

export function FilterValueSelector<TData>({ column, value, onSelect }: FilterValueSelectorProps<TData>) {
  const t = useDataTableCopy();
  const variant = readColumnFilterVariant(column);

  switch (variant) {
    case "boolean":
      return (
        <CommandGroup>
          <CommandItem
            value="true"
            onSelect={() => {
              onSelect("true");
            }}
          >
            {t("dataTable.filter.true")}
          </CommandItem>
          <CommandItem
            value="false"
            onSelect={() => {
              onSelect("false");
            }}
          >
            {t("dataTable.filter.false")}
          </CommandItem>
        </CommandGroup>
      );

    case "select":
    case "multiSelect":
      return <FilterOptionSelector options={column.columnDef.meta?.options} onSelect={onSelect} />;

    case "date":
    case "dateRange":
      return <FilterDateSelector column={column} value={value} onSelect={onSelect} />;

    case "text":
    case "number":
    case "range":
      return <FilterTextSelector value={value} onSelect={onSelect} />;
  }
}

function FilterOptionSelector({
  options = [],
  onSelect,
}: {
  options: readonly Option[] | undefined;
  onSelect: (value: string) => void;
}) {
  return (
    <CommandGroup>
      {options.map((option) => (
        <CommandItem
          key={option.value}
          value={option.value}
          className="[&>svg:last-child]:hidden"
          onSelect={() => {
            onSelect(option.value);
          }}
        >
          {option.icon && <option.icon />}
          <span className="truncate">{option.label}</span>
          {option.count && (
            <span className="ml-auto font-mono text-xs">
              <FormattedInteger value={option.count} />
            </span>
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function FilterDateSelector<TData>({ column, value, onSelect }: FilterValueSelectorProps<TData>) {
  const t = useDataTableCopy();
  return (
    <DatePicker
      autoFocus
      label={column.columnDef.meta?.label ?? t("dataTable.date.label")}
      {...(value ? { selected: new Date(value) } : {})}
      onSelect={(date) => {
        onSelect(toTimestampText(date));
      }}
    />
  );
}

function FilterTextSelector({ value, onSelect }: Pick<FilterValueSelectorProps<unknown>, "value" | "onSelect">) {
  const t = useDataTableCopy();
  const isEmpty = !value.trim();

  return (
    <CommandGroup>
      <CommandItem
        value={value}
        onSelect={() => {
          onSelect(value);
        }}
        disabled={isEmpty}
      >
        {isEmpty ? (
          <>
            <Text />
            <span>{t("dataTable.filter.typeToAdd")}</span>
          </>
        ) : (
          <>
            <BadgeCheck />
            <span className="truncate">{t("dataTable.filter.byValue", { value })}</span>
          </>
        )}
      </CommandItem>
    </CommandGroup>
  );
}
