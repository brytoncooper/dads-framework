/**
 * Pure rules for a master-detail list rail: how loaded pages become rows, when
 * to ask for more, when the loaded count is shown, and how the Name sort
 * header toggles the URL's sort string.
 */

/** The page shape a rail reads, structurally: what the domain web clients return. */
export type RailListPage<TItem> = {
  readonly items: readonly TItem[];
  readonly meta: { readonly total: number };
};

/** Every loaded row in server order, and the server's total for the whole list. */
export function flattenRailPages<TItem>(
  data: { readonly pages: readonly RailListPage<TItem>[] } | undefined,
): { readonly items: readonly TItem[]; readonly total: number } {
  if (data === undefined || data.pages.length === 0) {
    return { items: [], total: 0 };
  }
  const lastPage = data.pages[data.pages.length - 1];
  return {
    items: data.pages.flatMap((page) => page.items),
    total: lastPage?.meta.total ?? 0,
  };
}

/** How many pages beyond the last visible row a rail keeps loaded. */
export const RAIL_PAGES_AHEAD = 2;

/**
 * Whether the rail should request the next page now: more exists, nothing is
 * already in flight, and the last visible row is within `pagesAhead` pages of
 * the end of what is loaded.
 */
export function shouldLoadMoreRailRows(input: {
  readonly lastVisibleIndex: number;
  readonly loadedCount: number;
  readonly pageSize: number;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly pagesAhead?: number;
}): boolean {
  if (!input.hasNextPage || input.isFetchingNextPage) return false;
  if (input.lastVisibleIndex < 0) return false;
  const pagesAhead = input.pagesAhead ?? RAIL_PAGES_AHEAD;
  const remainingAfterVisible = input.loadedCount - 1 - input.lastVisibleIndex;
  return remainingAfterVisible < pagesAhead * input.pageSize;
}

/** "N of M loaded" is shown only while some rows are not loaded yet. */
export function isRailPartiallyLoaded(
  loadedCount: number,
  total: number,
): boolean {
  return loadedCount < total;
}

/** Direction of a sort string such as `name` or `-name` for one key; none when sorted by another key. */
export function railSortDirection(
  sort: string,
  key: string,
): "asc" | "desc" | null {
  if (sort === key) return "asc";
  if (sort === `-${key}`) return "desc";
  return null;
}

/** The Name header's next sort: ascending first, then flipping between the two directions. */
export function toggledNameSort(sort: string): "name" | "-name" {
  return railSortDirection(sort, "name") === "asc" ? "-name" : "name";
}

/**
 * Whether a list search change swaps the Active / Archived / All view. A
 * different status lists different records, so the record that was open does
 * not belong to the new list: the section's index address opens the new
 * list's first record, or shows the empty pane when there is none.
 */
export function isRailStatusChange(
  current: { readonly status?: string },
  next: { readonly status?: string },
): boolean {
  return current.status !== next.status;
}

/**
 * The key a rail row and the open address share. Slugs are only unique per
 * facility, so a company-wide rail (several facilities) keys on
 * `facilitySlug/slug`; a single-facility rail keys on the slug alone.
 */
export function railRecordKey(
  record: { readonly slug: string; readonly facilitySlug: string },
  companyWide: boolean,
): string {
  return companyWide ? `${record.facilitySlug}/${record.slug}` : record.slug;
}
