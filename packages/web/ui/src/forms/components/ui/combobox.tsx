"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import * as React from "react";

import { Button, cn } from "../../../elements/index.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./input-group.js";

/** What an option is matched by when it is not matched by identity. */
type ComboboxItemKey = string | number;

/**
 * The stable key of one option, or `null` when it has none.
 *
 * The `{ value, label }` fallback is Base UI's own convention, not an
 * invention here: the primitive already reads `value` for form submission and
 * `label` for the input's text off exactly that shape. Equality was the one
 * place it did not, so this makes the shape mean the same thing everywhere.
 */
function comboboxItemKey<Value>(
  item: Value,
  getKey: ((item: Value) => ComboboxItemKey | null | undefined) | undefined,
): ComboboxItemKey | null {
  if (getKey !== undefined) return getKey(item) ?? null;
  if (typeof item === "string" || typeof item === "number") return item;
  if (typeof item === "object" && item !== null && "value" in item) {
    const key: unknown = item.value;
    if (typeof key === "string" || typeof key === "number") return key;
  }
  return null;
}

/**
 * Groups the parts of a combobox, matching options to the selected value by a
 * stable key rather than by object identity.
 *
 * ## Why this diverges from the generated shadcn file
 *
 * Base UI's `Combobox.Root` compares an item to the selected value with
 * `Object.is` unless it is handed `isItemEqualToValue`. A form that derives
 * its options in the render body — `catalog.map(…)`, which is how options that
 * depend on anything else on the form are written — produces a new array of
 * new objects every render, so the option a person just took stops being equal
 * to the value it set one render later: no check mark, no highlight on
 * reopening, and a control that reads as refusing to pick. The failure is
 * silent, the workaround is memoizing every option array forever, and the
 * component is the only place that can state the rule once.
 *
 * The key is `getKey` where the caller gives one, otherwise the item's own
 * `value` (or the item itself, for plain string and number options). An item
 * with no derivable key falls back to identity, which is what it had before.
 *
 * `isItemEqualToValue` still wins outright when a caller passes it.
 *
 * Prefer a stable `getKey` — module-level, or memoized — because an inline one
 * rebuilds the comparer each render, exactly as an inline `isItemEqualToValue`
 * does today.
 */
function Combobox<Value, Multiple extends boolean | undefined = false>({
  getKey,
  isItemEqualToValue,
  ...props
}: ComboboxPrimitive.Root.Props<Value, Multiple> & {
  getKey?: ((item: Value) => ComboboxItemKey | null | undefined) | undefined;
}) {
  const matchesValue = React.useMemo(() => {
    if (isItemEqualToValue !== undefined) return isItemEqualToValue;
    return (itemValue: Value, value: Value): boolean => {
      if (Object.is(itemValue, value)) return true;
      const key = comboboxItemKey(itemValue, getKey);
      return key !== null && key === comboboxItemKey(value, getKey);
    };
  }, [isItemEqualToValue, getKey]);

  return (
    <ComboboxPrimitive.Root<Value, Multiple>
      isItemEqualToValue={matchesValue}
      {...props}
    />
  );
}

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxTrigger({
  className,
  children,
  size = "default",
  ...props
}: ComboboxPrimitive.Trigger.Props & {
  size?: "sm" | "default";
}) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      data-size={size}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[size=default]:h-9 data-[size=sm]:h-8 [@media(pointer:coarse)]:min-h-11 *:data-[slot=combobox-value]:line-clamp-1 *:data-[slot=combobox-value]:min-w-0 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40 motion-reduce:transition-none",
        "[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span
        data-slot="combobox-trigger-value"
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
      >
        {children}
      </span>
      <ChevronDownIcon
        data-slot="combobox-trigger-icon"
        className="pointer-events-none size-4 shrink-0 text-muted-foreground"
      />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroupButton variant="outline" size="icon-xs" />}
      className={cn(className)}
      {...props}
    >
      <XIcon className="pointer-events-none" />
    </ComboboxPrimitive.Clear>
  );
}

/**
 * A caller-owned button pinned under the scrolling option list.
 *
 * It is a sibling of `ComboboxList`, not a row inside it, so a long catalog
 * scrolls the options and leaves this button in view. The kit only places
 * the click and reports it. What the click does stays at the call site.
 */
function ComboboxAction({
  className,
  onMouseDown,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <div data-slot="combobox-action" className="shrink-0 border-t p-1">
      <Button
        type="button"
        size={size}
        variant={variant}
        className={cn("w-full", className)}
        {...props}
        onMouseDown={(event) => {
          event.preventDefault();
          onMouseDown?.(event);
        }}
      />
    </div>
  );
}

function ComboboxInput({
  className,
  children,
  startAddon,
  disabled = false,
  size = "default",
  showTrigger = true,
  showClear = false,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  size?: "default" | "sm";
  showTrigger?: boolean;
  showClear?: boolean;
  startAddon?: React.ReactNode;
}) {
  return (
    <InputGroup size={size} className={cn("w-auto min-w-0", className)}>
      {startAddon != null ? (
        <InputGroupAddon align="inline-start">{startAddon}</InputGroupAddon>
      ) : null}
      <ComboboxPrimitive.Input
        render={<InputGroupInput disabled={disabled} />}
        {...props}
      />
      {showTrigger || showClear ? (
        <InputGroupAddon align="inline-end">
          {showTrigger && (
            <InputGroupButton
              size="icon-xs"
              variant="outline"
              asChild
              data-slot="input-group-button"
              className="group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent"
              disabled={disabled}
            >
              <ComboboxTrigger />
            </InputGroupButton>
          )}
          {showClear && <ComboboxClear disabled={disabled} />}
        </InputGroupAddon>
      ) : null}
      {children}
    </InputGroup>
  );
}

/**
 * The search field that lives inside an open combobox popup.
 *
 * Pair with a closed `ComboboxTrigger` + `ComboboxValue`. The input is not
 * the closed control — it appears only after the list opens.
 */
function ComboboxSearch({
  className,
  startAddon,
  showTrigger = false,
  ...props
}: React.ComponentProps<typeof ComboboxInput>) {
  return (
    <div data-slot="combobox-search" className="min-w-0 shrink-0 border-b p-2">
      <ComboboxInput
        showTrigger={showTrigger}
        startAddon={startAddon ?? <SearchIcon aria-hidden />}
        className={cn(
          "min-w-0 w-full rounded-md before:rounded-[calc(var(--radius-md)-1px)]",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function ComboboxChips({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
  ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card bg-clip-padding px-2.5 py-1.5 text-sm shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 has-aria-invalid:border-destructive has-aria-invalid:ring-[3px] has-aria-invalid:ring-destructive/20 has-data-[slot=combobox-chip]:px-1.5 dark:bg-input/30 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: ComboboxPrimitive.Chip.Props & {
  showRemove?: boolean;
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        "flex h-[calc(--spacing(5.5))] w-fit items-center justify-center gap-1 rounded-sm bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-foreground has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0",
        className,
      )}
      {...props}
    >
      {children}
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          render={<Button variant="outline" size="icon-xs" />}
          className="-ml-1"
          data-slot="combobox-chip-remove"
        >
          <XIcon className="pointer-events-none" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  );
}

function ComboboxChipsInput({
  className,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "children">) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cn(
        "min-w-16 flex-1 outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null);
}

export {
  Combobox,
  ComboboxAction,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxClear,
  ComboboxInput,
  ComboboxSearch,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
};

export {
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxSeparator,
  ComboboxContent as ComboboxPopup,
} from "./combobox-options.js";
