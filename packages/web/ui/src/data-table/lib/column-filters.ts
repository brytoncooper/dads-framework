import { getDefaultFilterOperator } from "./data-table.js";
import type { ExtendedColumnFilter, FilterVariant } from "./data-table-types.js";
import type { FilterParamItem } from "./filter-param.js";
import { isKnownColumnId } from "./parsers.js";

/** Variants whose control offers a set of choices, so their value is a list. */
const LIST_VALUE_VARIANTS: ReadonlySet<FilterVariant> = new Set(["select", "multiSelect", "range", "dateRange"]);

/**
 * Put a URL's filters back together as the table's own filters.
 *
 * The URL carries only what a reader chose — which column, what value, and an
 * operator when it was not the obvious one. Everything else is a fact about
 * the column, so it comes from the column: the variant decides which control
 * renders and whether the value is a list, and the variant's first operator is
 * what "no operator" meant. A filter naming a column this table does not have
 * is dropped rather than shown as a control over nothing.
 */
export function toColumnFilters<TData>(
  filters: readonly FilterParamItem[],
  columnVariants: ReadonlyMap<string, FilterVariant>,
): ExtendedColumnFilter<TData>[] {
  const columnFilters: ExtendedColumnFilter<TData>[] = [];
  const usedPerColumn = new Map<string, number>();

  for (const filter of filters) {
    const variant = columnVariants.get(filter.id);
    if (variant === undefined) continue;
    if (!isKnownColumnId<TData>(filter.id, columnVariants)) continue;

    const used = usedPerColumn.get(filter.id) ?? 0;
    usedPerColumn.set(filter.id, used + 1);

    columnFilters.push({
      id: filter.id,
      value: matchValueToVariant(filter.value, variant),
      variant,
      operator: filter.operator ?? getDefaultFilterOperator(variant),
      filterId: used === 0 ? filter.id : `${filter.id}~${used}`,
    });
  }

  return columnFilters;
}

/**
 * Take the table's filters back down to what the URL should say — the column,
 * the value, and the operator only when the column would not have assumed it.
 */
export function toUrlFilters<TData>(
  filters: readonly ExtendedColumnFilter<TData>[],
  columnVariants: ReadonlyMap<string, FilterVariant>,
): FilterParamItem[] {
  return filters.map((filter) => {
    const variant = columnVariants.get(filter.id) ?? filter.variant;
    if (filter.operator === getDefaultFilterOperator(variant)) {
      return { id: filter.id, value: filter.value };
    }

    return { id: filter.id, operator: filter.operator, value: filter.value };
  });
}

function matchValueToVariant(value: string | string[], variant: FilterVariant): string | string[] {
  const values = Array.isArray(value) ? value : [value];
  if (LIST_VALUE_VARIANTS.has(variant)) return values;

  return values[0] ?? "";
}
