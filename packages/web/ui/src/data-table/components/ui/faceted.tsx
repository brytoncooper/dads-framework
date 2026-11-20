import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";

import { Badge, cn } from "../../../elements/index.js";
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

/**
 * One selected value, or several when `multiple` is set.
 *
 * A plain union rather than a conditional type keyed on `multiple`: the
 * precision was only ever recovered with `as` casts, which this repo bans.
 */
type FacetedValue = string | string[];

type FacetedContextValue = {
  value?: FacetedValue;
  onItemSelect?: (value: string) => void;
  multiple?: boolean;
};

const FacetedContext = React.createContext<FacetedContextValue | null>(null);

function toValueList(value: FacetedValue | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function useFacetedContext(name: string) {
  const context = React.useContext(FacetedContext);
  if (!context) {
    throw new Error(`\`${name}\` must be within Faceted`);
  }
  return context;
}

type FacetedProps = React.ComponentProps<typeof Popover> & {
  value?: FacetedValue;
  onValueChange?: (value: FacetedValue | undefined) => void;
  children?: React.ReactNode;
  multiple?: boolean;
};

function Faceted(props: FacetedProps) {
  const {
    open: openProp,
    onOpenChange: onOpenChangeProp,
    value,
    onValueChange,
    children,
    multiple = false,
    ...facetedProps
  } = props;

  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;

  const onOpenChange = React.useCallback(
    (newOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(newOpen);
      }
      onOpenChangeProp?.(newOpen);
    },
    [isControlled, onOpenChangeProp],
  );

  const onItemSelect = React.useCallback(
    (selectedValue: string) => {
      if (!onValueChange) return;

      if (multiple) {
        const currentValues = Array.isArray(value) ? value : [];
        onValueChange(
          currentValues.includes(selectedValue)
            ? currentValues.filter((item) => item !== selectedValue)
            : [...currentValues, selectedValue],
        );
        return;
      }

      onValueChange(value === selectedValue ? undefined : selectedValue);
      requestAnimationFrame(() => {
        onOpenChange(false);
      });
    },
    [multiple, value, onValueChange, onOpenChange],
  );

  const contextValue = React.useMemo<FacetedContextValue>(
    () => ({
      ...(value === undefined ? {} : { value }),
      onItemSelect,
      multiple,
    }),
    [value, onItemSelect, multiple],
  );

  return (
    <FacetedContext.Provider value={contextValue}>
      <Popover open={open} onOpenChange={onOpenChange} {...facetedProps}>
        {children}
      </Popover>
    </FacetedContext.Provider>
  );
}

function FacetedTrigger(props: React.ComponentProps<typeof PopoverTrigger>) {
  const { className, children, ...triggerProps } = props;

  return (
    <PopoverTrigger
      {...triggerProps}
      className={cn("justify-between text-left", className)}
    >
      {children}
    </PopoverTrigger>
  );
}

type FacetedBadgeListProps = React.ComponentProps<"div"> & {
  options?: { label: string; value: string }[];
  max?: number;
  badgeClassName?: string;
  placeholder?: string;
};

function FacetedBadgeList(props: FacetedBadgeListProps) {
  const {
    options = [],
    max = 2,
    placeholder,
    className,
    badgeClassName,
    ...badgeListProps
  } = props;

  const t = useDataTableCopy();
  const context = useFacetedContext("FacetedBadgeList");
  const values = toValueList(context.value);
  const resolvedPlaceholder =
    placeholder ?? t("dataTable.filter.selectOptions");

  const getLabel = React.useCallback(
    (value: string) => {
      const option = options.find((opt) => opt.value === value);
      return option?.label ?? value;
    },
    [options],
  );

  if (values.length === 0) {
    return (
      <div
        {...badgeListProps}
        className="flex w-full items-center gap-1 text-muted-foreground"
      >
        {resolvedPlaceholder}
        <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
      </div>
    );
  }

  return (
    <div
      {...badgeListProps}
      className={cn("flex flex-wrap items-center gap-1", className)}
    >
      {max < values.length ? (
        <Badge
          variant="secondary"
          className={cn("rounded-sm px-1 font-normal", badgeClassName)}
        >
          {t("dataTable.filter.selectedCount", { count: values.length })}
        </Badge>
      ) : (
        values.map((value) => (
          <Badge
            key={value}
            variant="secondary"
            className={cn("rounded-sm px-1 font-normal", badgeClassName)}
          >
            <span className="truncate">{getLabel(value)}</span>
          </Badge>
        ))
      )}
    </div>
  );
}

function FacetedContent(props: React.ComponentProps<typeof PopoverContent>) {
  const { className, children, ...contentProps } = props;

  return (
    <PopoverContent
      {...contentProps}
      align="start"
      className={cn(
        "w-[200px] origin-(--radix-popover-content-transform-origin) p-0",
        className,
      )}
    >
      <Command>{children}</Command>
    </PopoverContent>
  );
}

const FacetedInput = CommandInput;

const FacetedList = CommandList;

const FacetedEmpty = CommandEmpty;

const FacetedGroup = CommandGroup;

type FacetedItemProps = React.ComponentProps<typeof CommandItem> & {
  value: string;
};

function FacetedItem(props: FacetedItemProps) {
  const { value, onSelect, className, children, ...itemProps } = props;
  const context = useFacetedContext("FacetedItem");

  const isSelected = context.multiple
    ? Array.isArray(context.value) && context.value.includes(value)
    : context.value === value;

  const onItemSelect = React.useCallback(
    (currentValue: string) => {
      if (onSelect) {
        onSelect(currentValue);
      } else if (context.onItemSelect) {
        context.onItemSelect(currentValue);
      }
    },
    [onSelect, context],
  );

  return (
    <CommandItem
      aria-selected={isSelected}
      data-selected={isSelected}
      className={cn("gap-2", className)}
      onSelect={() => {
        onItemSelect(value);
      }}
      {...itemProps}
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border border-primary",
          isSelected
            ? "bg-primary text-primary-foreground"
            : "opacity-50 [&_svg]:invisible",
        )}
      >
        <Check className="size-4" />
      </span>
      {children}
    </CommandItem>
  );
}

const FacetedSeparator = CommandSeparator;

export {
  Faceted,
  FacetedBadgeList,
  FacetedContent,
  FacetedEmpty,
  FacetedGroup,
  FacetedInput,
  FacetedItem,
  FacetedList,
  FacetedSeparator,
  FacetedTrigger,
};
