import { cn } from "../../../elements/index.js";

import { type FilterGroup, toggleFilterValue } from "../../lib/filter-groups.js";

/**
 * A filter group laid flat for the phone Filters sheet: its name, then one
 * toggle chip per option, so a thumb sets it without opening a popover.
 */
export function FilterGroupToggles({ group }: { readonly group: FilterGroup }) {
  return (
    <div
      role="group"
      aria-label={group.label}
      data-slot="filter-group-toggles"
      className="flex w-full flex-col gap-1.5"
    >
      <span aria-hidden="true" className="text-xs font-medium text-foreground">
        {group.label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {group.options.map((option) => {
          const isOn = group.selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isOn}
              className={cn(
                "inline-flex min-h-11 items-center rounded-full border border-dashed border-input bg-background px-3.5 text-sm font-medium text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                isOn && "border-solid border-primary bg-primary/10 text-link",
              )}
              onClick={() => {
                group.onSelectedChange(toggleFilterValue(group, option.value));
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
