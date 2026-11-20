/** One choice inside a filter group: the value the page stores and its label. */
export type FilterGroupOption = {
  readonly value: string;
  readonly label: string;
};

/**
 * One secondary axis of a list page, such as an order's Type or a ticket's
 * Direction. Shown as a `FilterPill` on wide screens, as inline toggle chips
 * in the phone Filters sheet, and as one removable chip per applied value.
 *
 * `selected` is the page's own state (usually a URL search param); every
 * change arrives through `onSelectedChange` with the values in option order.
 */
export type FilterGroup = {
  /** Stable key for the group, such as the search param it writes. */
  readonly id: string;
  /** The axis name shown on the pill and chips: "Type", "Direction". */
  readonly label: string;
  readonly options: readonly FilterGroupOption[];
  readonly selected: readonly string[];
  readonly onSelectedChange: (selected: readonly string[]) => void;
  /** Several values at once (the default), or at most one. */
  readonly multiple?: boolean;
  /**
   * A search box above the options, for long lists such as companies. Chosen
   * values stay listed while the search hides the rest.
   */
  readonly searchable?: boolean;
  /**
   * For a single-select group whose list opens on a default view: the option
   * the pill's radio list shows chosen while `selected` is empty. It is not an
   * applied filter, so it adds no chip and the pill stays idle.
   */
  readonly defaultValue?: string;
};

/**
 * The options a pill's search leaves showing: matches, plus every chosen
 * value. `includes` is the reader's locale-aware text match.
 */
export function optionsMatchingSearch(
  group: Pick<FilterGroup, "options" | "selected">,
  term: string,
  includes: (value: string, query: string) => boolean,
): readonly FilterGroupOption[] {
  if (term.trim().length === 0) return group.options;
  return group.options.filter(
    (option) =>
      group.selected.includes(option.value) || includes(option.label, term),
  );
}

/** One applied value, as its removable chip names it. */
export type AppliedFilterValue = {
  readonly groupId: string;
  readonly groupLabel: string;
  readonly value: string;
  readonly valueLabel: string;
};

/**
 * The next selection after the reader presses one option. A multi-select
 * group adds or removes it; a single-select group switches to it, or clears
 * when the reader presses the option already chosen. Values come back in
 * option order, and values no option knows are dropped.
 */
export function toggleFilterValue(
  group: Pick<FilterGroup, "options" | "selected" | "multiple">,
  value: string,
): readonly string[] {
  const isSelected = group.selected.includes(value);
  if (group.multiple === false) return isSelected ? [] : [value];

  const next = isSelected
    ? group.selected.filter((selected) => selected !== value)
    : [...group.selected, value];
  return inOptionOrder(group.options, next);
}

/** The selection without one value, in option order. */
export function removeFilterValue(
  group: Pick<FilterGroup, "options" | "selected">,
  value: string,
): readonly string[] {
  return inOptionOrder(
    group.options,
    group.selected.filter((selected) => selected !== value),
  );
}

/** The labels of a group's selected values, in option order. */
export function selectedFilterLabels(
  group: Pick<FilterGroup, "options" | "selected">,
): readonly string[] {
  return group.options
    .filter((option) => group.selected.includes(option.value))
    .map((option) => option.label);
}

/** Every applied value across the groups, in group then option order. */
export function listAppliedFilterValues(
  groups: readonly FilterGroup[],
): readonly AppliedFilterValue[] {
  return groups.flatMap((group) =>
    group.options
      .filter((option) => group.selected.includes(option.value))
      .map((option) => ({
        groupId: group.id,
        groupLabel: group.label,
        value: option.value,
        valueLabel: option.label,
      })),
  );
}

/** How many values are applied across the groups. */
export function countAppliedFilterValues(
  groups: readonly FilterGroup[],
): number {
  return listAppliedFilterValues(groups).length;
}

function inOptionOrder(
  options: readonly FilterGroupOption[],
  values: readonly string[],
): readonly string[] {
  return options
    .map((option) => option.value)
    .filter((value) => values.includes(value));
}
