import { ChevronDown } from "lucide-react";
import * as React from "react";

import { useLocaleFormatting } from "../../../copy/index.js";
import { cn } from "../../../elements/index.js";
import {
  Checkbox,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
} from "../../../forms/index.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import {
  type FilterGroup,
  optionsMatchingSearch,
  selectedFilterLabels,
  toggleFilterValue,
} from "../../lib/filter-groups.js";

/** A `FilterGroup` without its key; spread a group straight in. */
export type FilterPillProps = Omit<FilterGroup, "id"> & {
  readonly className?: string;
};

/**
 * One secondary axis of a list page as a pill: dashed "Type" while nothing is
 * chosen, solid and primary-tinted "Type: Sales, Transfers" once something is.
 * It opens a popover with a checkbox list, or a radio list when the group
 * takes one value (`multiple: false`). Every change applies at once. A
 * `searchable` group puts a search box above a long option list.
 */
export function FilterPill({
  label,
  options,
  selected,
  onSelectedChange,
  multiple = true,
  searchable = false,
  defaultValue,
  className,
}: FilterPillProps) {
  const t = useDataTableCopy();
  const [term, setTerm] = React.useState("");
  const { formatList, humanTextIncludes } = useLocaleFormatting();
  const shown = searchable
    ? optionsMatchingSearch({ options, selected }, term, humanTextIncludes)
    : options;
  const labels = selectedFilterLabels({ options, selected });
  const isSet = labels.length > 0;
  const group = { options, selected, multiple };

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setTerm("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="filter-pill"
          className={cn(
            "inline-flex h-8 max-w-72 shrink-0 items-center gap-1 rounded-full border border-dashed border-input bg-background px-3 text-sm font-medium text-foreground outline-none transition-colors motion-reduce:transition-none",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            isSet
              ? "border-solid border-primary bg-primary/10 text-link hover:text-link"
              : "hover:border-solid hover:bg-accent",
            className,
          )}
        >
          <span className="truncate">
            {isSet
              ? t("dataTable.filter.pillValue", {
                  filterLabel: label,
                  valueList: formatList(labels, {
                    type: "unit",
                    style: "short",
                  }),
                })
              : label}
          </span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        {searchable && (
          <FilterPillSearch
            label={label}
            term={term}
            setTerm={setTerm}
            hasOptions={shown.length > 0}
          />
        )}
        {multiple ? (
          <FilterPillCheckboxList
            label={label}
            options={shown}
            selected={selected}
            onToggle={(value) => {
              onSelectedChange(toggleFilterValue(group, value));
            }}
          />
        ) : (
          <FilterPillRadioList
            label={label}
            options={shown}
            selected={selected}
            {...(defaultValue === undefined ? {} : { defaultValue })}
            onSelectedChange={onSelectedChange}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function FilterPillCheckboxList({
  label,
  options,
  selected,
  onToggle,
}: Pick<FilterGroup, "label" | "options" | "selected"> & {
  readonly onToggle: (value: string) => void;
}) {
  const idPrefix = React.useId();
  return (
    <div
      role="group"
      aria-label={label}
      className="flex max-h-72 flex-col overflow-y-auto"
    >
      {options.map((option) => {
        const id = `${idPrefix}-${option.value}`;
        return (
          <Label
            key={option.value}
            htmlFor={id}
            className="min-h-9 cursor-pointer rounded-sm px-2 py-1.5 font-normal hover:bg-accent [@media(pointer:coarse)]:min-h-11"
          >
            <Checkbox
              id={id}
              checked={selected.includes(option.value)}
              onCheckedChange={() => {
                onToggle(option.value);
              }}
            />
            {option.label}
          </Label>
        );
      })}
    </div>
  );
}

function FilterPillRadioList({
  label,
  options,
  selected,
  defaultValue,
  onSelectedChange,
}: Pick<
  FilterGroup,
  "label" | "options" | "selected" | "defaultValue" | "onSelectedChange"
>) {
  const idPrefix = React.useId();
  return (
    <RadioGroup
      aria-label={label}
      value={selected[0] ?? defaultValue ?? ""}
      onValueChange={(value) => {
        onSelectedChange([value]);
      }}
      className="max-h-72 gap-0 overflow-y-auto"
    >
      {options.map((option) => {
        const id = `${idPrefix}-${option.value}`;
        return (
          <Label
            key={option.value}
            htmlFor={id}
            className="min-h-9 cursor-pointer rounded-sm px-2 py-1.5 font-normal hover:bg-accent [@media(pointer:coarse)]:min-h-11"
          >
            <RadioGroupItem id={id} value={option.value} />
            {option.label}
          </Label>
        );
      })}
    </RadioGroup>
  );
}

function FilterPillSearch({
  label,
  term,
  setTerm,
  hasOptions,
}: {
  label: string;
  term: string;
  setTerm: (term: string) => void;
  hasOptions: boolean;
}) {
  const t = useDataTableCopy();
  const searchLabel = t("dataTable.filter.searchGroup", { filterLabel: label });

  return (
    <>
      <Input
        type="search"
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
        }}
        placeholder={searchLabel}
        aria-label={searchLabel}
        className="mb-1 h-8"
      />
      {!hasOptions && (
        <p className="px-2 py-1.5 text-muted-foreground text-sm">
          {t("dataTable.state.noOptions")}
        </p>
      )}
    </>
  );
}
