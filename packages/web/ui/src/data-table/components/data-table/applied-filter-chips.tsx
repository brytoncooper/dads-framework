import { X } from "lucide-react";

import { cn } from "../../../elements/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import {
  type FilterGroup,
  listAppliedFilterValues,
  removeFilterValue,
} from "../../lib/filter-groups.js";

type AppliedFilterChipsProps = {
  readonly groups: readonly FilterGroup[];
  /**
   * Clears every narrowing the chips stand for, in one write. Pages whose
   * groups share one URL update pass this; without it each group is cleared
   * through its own `onSelectedChange`.
   */
  readonly onClearAll?: () => void;
  readonly className?: string;
};

/**
 * One removable chip per applied filter value ("Type: Sales ×") and a
 * Clear All. Renders nothing while no value is applied. Chips wrap on wide
 * screens and scroll in one row on phones.
 */
export function AppliedFilterChips({
  groups,
  onClearAll,
  className,
}: AppliedFilterChipsProps) {
  const t = useDataTableCopy();
  const applied = listAppliedFilterValues(groups);
  if (applied.length === 0) return null;

  const clearAll =
    onClearAll ??
    (() => {
      for (const group of groups) {
        if (group.selected.length > 0) group.onSelectedChange([]);
      }
    });

  return (
    <div
      role="group"
      aria-label={t("dataTable.filter.appliedList")}
      data-slot="applied-filter-chips"
      className={cn(
        "flex min-w-0 items-center gap-1.5 [scrollbar-width:none] max-md:overflow-x-auto md:flex-wrap",
        className,
      )}
    >
      {applied.map((value) => {
        const group = groups.find(
          (candidate) => candidate.id === value.groupId,
        );
        const names = {
          filterLabel: value.groupLabel,
          valueLabel: value.valueLabel,
        };
        return (
          <span
            key={`${value.groupId}:${value.value}`}
            data-slot="applied-filter-chip"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 py-0.5 pr-0.5 pl-2.5 text-xs font-medium whitespace-nowrap text-link"
          >
            {t("dataTable.filter.appliedValue", names)}
            <button
              type="button"
              aria-label={t("dataTable.action.removeAppliedFilter", names)}
              className="inline-flex size-6 items-center justify-center rounded-full outline-none hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring/50 [@media(pointer:coarse)]:size-8"
              onClick={() =>
                group?.onSelectedChange(removeFilterValue(group, value.value))
              }
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        className="shrink-0 rounded-sm px-1 text-xs whitespace-nowrap text-foreground underline underline-offset-2 outline-none hover:text-link focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={clearAll}
      >
        {t("dataTable.action.clearAll")}
      </button>
    </div>
  );
}
