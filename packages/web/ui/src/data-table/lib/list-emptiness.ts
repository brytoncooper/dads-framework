/**
 * Which of the things an empty list means.
 *
 * A table with no rows is two completely different situations wearing the same
 * pixels, and they need opposite answers. A resource nobody has populated yet
 * needs a way in — a title, a sentence, and the button that creates the first
 * one — and nothing else: tabs and filters over nothing are just places to
 * click into the same emptiness. A view or search that matched nothing among
 * records that do exist needs the table itself, because the tab or filter
 * that caused it is on screen and the reader has to see it to move on.
 *
 * ## Why the unfiltered total is asked for
 *
 * The paginated envelope's `meta.total` is the **filtered** total, and a view
 * tab (Open, Closed) narrows like any filter. Deciding "nothing exists" from a
 * narrowed zero made a company with no records flip between the table (on a
 * tab) and the empty page (on All) with every click. So a narrowed zero is
 * settled by a second, unnarrowed count: {@link needsUnfilteredTotal} says
 * when to fetch it, and `CHECKING` holds the page on its skeleton until it
 * answers, so the reader never sees the wrong state first. A count that
 * fails falls back to `NO_MATCHES`: the table and its tabs stay usable
 * instead of the page waiting on a skeleton that will never resolve.
 */

export type ListEmptiness =
  /** Nothing is here at all, in any view — offer the way to create the first one. */
  | "ZERO"
  /** Things exist; this view, search, or filter found none of them. */
  | "NO_MATCHES"
  /** A narrowed view came back empty and the unnarrowed count has not answered yet. */
  | "CHECKING"
  /** There are rows to show. */
  | "HAS_ROWS";

/**
 * `total` is the narrowed total; `activeFilterCount` counts every narrowing,
 * the view tab included; `unfilteredTotal` is the unnarrowed count, undefined
 * until it answers (it is only fetched when {@link needsUnfilteredTotal});
 * `unfilteredFailed` says that count failed and will not answer.
 */
export function readListEmptiness({
  total,
  activeFilterCount,
  unfilteredTotal,
  unfilteredFailed,
}: {
  readonly total: number;
  readonly activeFilterCount: number;
  readonly unfilteredTotal: number | undefined;
  readonly unfilteredFailed: boolean;
}): ListEmptiness {
  if (total > 0) return "HAS_ROWS";
  if (activeFilterCount === 0) return "ZERO";
  if (unfilteredTotal === undefined) {
    return unfilteredFailed ? "NO_MATCHES" : "CHECKING";
  }
  return unfilteredTotal === 0 ? "ZERO" : "NO_MATCHES";
}

/** Whether a page must fetch its unnarrowed count to tell an empty view from an empty resource. */
export function needsUnfilteredTotal({
  total,
  activeFilterCount,
}: {
  readonly total: number | undefined;
  readonly activeFilterCount: number;
}): boolean {
  return total === 0 && activeFilterCount > 0;
}

/**
 * `CHECKING` for a page that has not shown its table yet, and `NO_MATCHES`
 * for one that has.
 *
 * `CHECKING` holds a page on its skeleton so a first look never shows the
 * wrong state. Once the table is on screen, though, the reader is using it:
 * a search that narrows to nothing must not swap the table for a skeleton,
 * because that unmounts the search box mid-word and drops the keys typed
 * while it is gone. A table that has shown rows, or a counted no-match, has
 * already proved the resource is not empty — so "no matches" is the answer
 * the probe will give, and it is shown while the probe confirms it.
 */
export function keepTableWhileChecking(
  emptiness: ListEmptiness | undefined,
  tableShown: boolean,
): ListEmptiness | undefined {
  return emptiness === "CHECKING" && tableShown ? "NO_MATCHES" : emptiness;
}
