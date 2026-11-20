import { useVirtualizer } from "@tanstack/react-virtual";
import * as React from "react";

import { Button, Skeleton } from "../../../elements/index.js";

import { usePageCopy } from "../../copy/page-copy.js";
import {
  isRailPartiallyLoaded,
  shouldLoadMoreRailRows,
} from "./logic/rail-list.js";
import { useIsMasterDetailDesktop } from "./master-detail-layout.js";

/** First-render height guess for one two-line row; rows are measured once drawn. */
const ESTIMATED_ROW_HEIGHT = 56;
const OVERSCAN_ROWS = 8;
const SKELETON_ROWS = 8;

/** What the list needs from the section's infinite query, already flattened. */
export type MasterDetailListProps<TItem> = {
  /** Every loaded row in server order (`flattenRailPages(query.data).items`). */
  readonly items: readonly TItem[];
  /** The server's total for the whole filtered list (`meta.total`). */
  readonly total: number;
  /** Rows per server page, for the two-pages-ahead prefetch. */
  readonly pageSize: number;
  readonly status: "pending" | "error" | "success";
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  /** Request the next page; called by the prefetch and by Load More. */
  readonly fetchNextPage: () => void;
  readonly onRetry: () => void;
  /** Stable identity of a row, usually its slug. */
  readonly getKey: (item: TItem) => string;
  /** The key of the record the address names, if any. */
  readonly selectedKey?: string;
  /** Draws one row, usually a `MasterDetailRow`. */
  readonly renderRow: (item: TItem, selected: boolean) => React.ReactNode;
  readonly emptyLabel: string;
  readonly loadingLabel: string;
  readonly errorLabel: string;
  /**
   * Given only at the section's index address: called once with the first
   * row on desktop so the record pane is never blank. The caller navigates
   * to that record with `replace: true`, keeping the list's search.
   */
  readonly onAutoOpen?: (item: TItem) => void;
};

/**
 * The rail's virtualized rows. Only the rows in view (plus a small overscan)
 * are in the DOM. While the reader scrolls it keeps about two server pages
 * loaded past the last visible row; a Load More button at the end is the
 * fallback that always reaches the next page, and "N of M loaded" shows while
 * the list is incomplete. Filtering, search and sort are server query params,
 * never a filter over loaded rows.
 */
export function MasterDetailList<TItem>({
  items,
  total,
  pageSize,
  status,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onRetry,
  getKey,
  selectedKey,
  renderRow,
  emptyLabel,
  loadingLabel,
  errorLabel,
  onAutoOpen,
}: MasterDetailListProps<TItem>) {
  const t = usePageCopy();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const isDesktop = useIsMasterDetailDesktop();

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getKey(item);
    },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;

  usePrefetchAhead({
    lastVisibleIndex,
    loadedCount: items.length,
    pageSize,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });

  useAutoOpenFirstRow({ items, isDesktop, onAutoOpen });
  useRevealSelectedRowOnce({ items, getKey, selectedKey, virtualizer });

  if (items.length === 0) {
    return (
      <EmptyRail
        status={status}
        onRetry={onRetry}
        labels={{ loadingLabel, errorLabel, emptyLabel }}
      />
    );
  }

  return (
    <>
      <div
        ref={scrollRef}
        data-slot="master-detail-list"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <ul
          className="relative m-0 list-none p-0"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((row) => {
            const item = items[row.index];
            if (item === undefined) return null;
            return (
              <li
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {renderRow(item, getKey(item) === selectedKey)}
              </li>
            );
          })}
        </ul>
        {hasNextPage ? (
          <div className="p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={isFetchingNextPage}
              onClick={fetchNextPage}
            >
              {isFetchingNextPage
                ? t("page.masterDetail.loadingMore")
                : t("page.masterDetail.loadMore")}
            </Button>
          </div>
        ) : null}
      </div>
      {isRailPartiallyLoaded(items.length, total) ? (
        <p
          role="status"
          data-slot="master-detail-loaded-count"
          className="border-t border-border px-3 py-2 text-muted-foreground text-xs tabular-nums"
        >
          {t("page.masterDetail.loaded", {
            loaded: items.length,
            total,
          })}
        </p>
      ) : null}
    </>
  );
}

// Rows already loaded stay in view through a failed background refetch.
function EmptyRail({
  status,
  onRetry,
  labels: { loadingLabel, errorLabel, emptyLabel },
}: {
  readonly status: MasterDetailListProps<unknown>["status"];
  readonly onRetry: () => void;
  readonly labels: {
    readonly loadingLabel: string;
    readonly errorLabel: string;
    readonly emptyLabel: string;
  };
}) {
  const t = usePageCopy();
  if (status === "pending") return <RailSkeleton label={loadingLabel} />;
  if (status === "error") {
    return (
      <div className="flex flex-col items-start gap-2 p-3">
        <p className="text-muted-foreground text-sm">{errorLabel}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("page.masterDetail.retry")}
        </Button>
      </div>
    );
  }
  return <p className="p-3 text-muted-foreground text-sm">{emptyLabel}</p>;
}

function RailSkeleton({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3 p-3">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/**
 * Asks for the next page while fewer than two pages remain past the last
 * visible row. One request per loaded length: a failed page is not retried
 * in a loop, and Load More stays the way to ask again.
 */
function usePrefetchAhead({
  lastVisibleIndex,
  loadedCount,
  pageSize,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  readonly lastVisibleIndex: number;
  readonly loadedCount: number;
  readonly pageSize: number;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => void;
}) {
  const latestFetchNextPage = React.useRef(fetchNextPage);
  React.useEffect(() => {
    latestFetchNextPage.current = fetchNextPage;
  }, [fetchNextPage]);
  const requestedAtLength = React.useRef<number | null>(null);
  React.useEffect(() => {
    // A new search or filter starts again from an empty list.
    if (
      requestedAtLength.current !== null &&
      loadedCount < requestedAtLength.current
    ) {
      requestedAtLength.current = null;
    }
    if (requestedAtLength.current === loadedCount) return;
    if (
      !shouldLoadMoreRailRows({
        lastVisibleIndex,
        loadedCount,
        pageSize,
        hasNextPage,
        isFetchingNextPage,
      })
    ) {
      return;
    }
    requestedAtLength.current = loadedCount;
    latestFetchNextPage.current();
  }, [
    lastVisibleIndex,
    loadedCount,
    pageSize,
    hasNextPage,
    isFetchingNextPage,
  ]);
}

/** Opens the first row once per visit to the index address, on desktop only. */
function useAutoOpenFirstRow<TItem>({
  items,
  isDesktop,
  onAutoOpen,
}: {
  readonly items: readonly TItem[];
  readonly isDesktop: boolean;
  readonly onAutoOpen: ((item: TItem) => void) | undefined;
}) {
  const opened = React.useRef(false);
  const enabled = onAutoOpen !== undefined;
  React.useEffect(() => {
    if (!enabled) opened.current = false;
  }, [enabled]);
  const first = items[0];
  React.useEffect(() => {
    if (opened.current || !isDesktop || !onAutoOpen || first === undefined) {
      return;
    }
    opened.current = true;
    onAutoOpen(first);
  }, [first, isDesktop, onAutoOpen]);
}

/** The part of the virtualizer the reveal reads: its visible band and rows, and the scroll request. */
type RevealVirtualizer = {
  readonly scrollToIndex: (
    index: number,
    options: { readonly align: "center" },
  ) => void;
  readonly range: {
    readonly startIndex: number;
    readonly endIndex: number;
  } | null;
  readonly scrollOffset: number | null;
  readonly scrollRect: { readonly height: number } | null;
  readonly getVirtualItems: () => readonly {
    readonly index: number;
    readonly start: number;
    readonly end: number;
  }[];
};

/**
 * A deep link to a loaded record scrolls its row into view, once per visit.
 *
 * The reveal is finished only when the whole row is inside the scroll
 * container's visible band, not when the scroll was requested. A row that only
 * overlaps the band's edge (the last row of a short list, clipped by the pane)
 * is in the virtualizer's range yet still hidden, so it is not enough.
 *
 * Under StrictMode (the dev app) the virtualizer is torn down and re-attached
 * right after mount, and the re-attach restores the scroll offset it still
 * holds (0, since the browser's scroll event has not arrived yet), undoing a
 * scroll requested on mount. So the request is repeated after each render
 * until the row is really in view; once it is, later clicks on other rows
 * never scroll the list again.
 */
function useRevealSelectedRowOnce<TItem>({
  items,
  getKey,
  selectedKey,
  virtualizer,
}: {
  readonly items: readonly TItem[];
  readonly getKey: (item: TItem) => string;
  readonly selectedKey: string | undefined;
  readonly virtualizer: RevealVirtualizer;
}) {
  const revealed = React.useRef(false);
  // No dependency list: the visible range changes inside the virtualizer, not in props.
  React.useEffect(() => {
    if (revealed.current || selectedKey === undefined) return;
    const index = items.findIndex((item) => getKey(item) === selectedKey);
    if (index < 0) return;
    if (isRowFullyVisible(virtualizer, index)) {
      revealed.current = true;
      return;
    }
    // Centered, so rows measured taller than the estimate cannot leave it clipped at an edge.
    virtualizer.scrollToIndex(index, { align: "center" });
  });
}

/** Whether the row sits wholly inside the scroll container's visible band (a taller-than-band row counts once it fills it). */
function isRowFullyVisible(
  virtualizer: RevealVirtualizer,
  index: number,
): boolean {
  if (!isInVisibleRange(virtualizer.range, index)) return false;
  const row = virtualizer
    .getVirtualItems()
    .find((item) => item.index === index);
  if (row === undefined) return false;
  const bandStart = virtualizer.scrollOffset ?? 0;
  const bandEnd = bandStart + (virtualizer.scrollRect?.height ?? 0);
  const fillsBand = row.start <= bandStart && row.end >= bandEnd;
  return fillsBand || (row.start >= bandStart && row.end <= bandEnd);
}

function isInVisibleRange(
  range: RevealVirtualizer["range"],
  index: number,
): boolean {
  return range !== null && index >= range.startIndex && index <= range.endIndex;
}
