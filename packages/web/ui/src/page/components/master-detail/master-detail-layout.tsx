import * as React from "react";

import { cn } from "../../../elements/index.js";

import { usePageCopy } from "../../copy/page-copy.js";

/**
 * Tailwind's `lg` breakpoint. At and above it the list rail and the record sit
 * side by side; below it the screen shows one of them at a time.
 */
export const MASTER_DETAIL_DESKTOP_QUERY = "(min-width: 1024px)";

/** The list's own URL params: the only search a link between records or back to the list carries. */
export type MasterDetailListSearch = Readonly<Record<string, string | number | undefined>>;

const MasterDetailPaneContext = React.createContext(false);
const MasterDetailListSearchContext = React.createContext<MasterDetailListSearch | undefined>(undefined);

/**
 * Whether this component renders inside a master-detail record pane. A show
 * page's Back link reads it to step aside on desktop, where the list is
 * already beside the record.
 */
export function useInMasterDetailPane(): boolean {
  return React.useContext(MasterDetailPaneContext);
}

/**
 * The list search (filters, sort, page size) the enclosing frame was given, for
 * the links that stay inside the section: a rail row opening a record and a
 * record's Back link. Record-only params such as an asset's `tab` are never in
 * it, so they cannot follow the reader to another record or back to the list.
 * Undefined outside a frame, which is a link with no search.
 */
export function useMasterDetailListSearch(): MasterDetailListSearch | undefined {
  return React.useContext(MasterDetailListSearchContext);
}

/**
 * Whether the viewport is wide enough for the two-pane layout. Read
 * synchronously on first render; false where the browser cannot answer (no
 * `matchMedia`), so tests and old browsers get the one-pane behaviour.
 */
export function useIsMasterDetailDesktop(): boolean {
  return React.useSyncExternalStore(subscribeToDesktopWidth, readIsDesktopWidth, readIsDesktopWidthOnServer);
}

/**
 * The master-detail frame for a list section: a list rail about 288px
 * (18rem, matching the sidebar) wide that is always visible on desktop, and the selected record's own show
 * page beside it. Each pane scrolls on its own, so the rail keeps its scroll
 * position while the record changes.
 *
 * Below the desktop breakpoint only one pane shows: the rail when nothing is
 * `selected` (the section's index address), the record when one is. The
 * record's own Back link returns to the list there.
 *
 * The frame sizes itself from the workspace shell, never from the viewport.
 * It carries `data-fills-viewport`; the shell reads that to give its main area
 * exactly the viewport height with no padding, so this `flex-1 min-h-0` frame
 * takes whatever the header and any banner leave. Only the list's own
 * scroller and the record pane scroll (on a phone too, where the record pane
 * carries the padding the shell gives up); the page itself never does. On
 * desktop the single grid row is `minmax(0,1fr)` so the panes cannot grow it.
 *
 * Render it from the section's layout route with the route's `<Outlet />` as
 * `children`, so the rail is not remounted when the record changes.
 */
export function MasterDetailLayout({
  rail,
  selected,
  label,
  listSearch,
  children,
}: {
  /** The section's list rail, usually a `MasterDetailRail`. */
  readonly rail: React.ReactNode;
  /** True when the address names a record, so phones show the record instead of the list. */
  readonly selected: boolean;
  /** What the rail lists, for assistive technology: "Assets". */
  readonly label: string;
  /** The section's list search (the rail's filters and sort), carried by row and Back links. */
  readonly listSearch: MasterDetailListSearch;
  /** The record pane: the layout route's `<Outlet />`. */
  readonly children: React.ReactNode;
}) {
  return (
    <MasterDetailListSearchContext.Provider value={listSearch}>
      <div
        data-slot="master-detail"
        data-selected={selected ? "true" : "false"}
        data-fills-viewport=""
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          "lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden",
        )}
      >
        <aside
          aria-label={label}
          data-slot="master-detail-rail-pane"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card",
            "lg:flex lg:overflow-hidden lg:border-r lg:border-border",
            selected ? "hidden" : "flex",
          )}
        >
          {rail}
        </aside>
        <div
          data-slot="master-detail-record-pane"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6 [body:has([data-screen-assistant-launcher])_&]:pb-24",
            "lg:flex",
            selected ? "flex" : "hidden",
          )}
        >
          <MasterDetailPaneContext.Provider value>{children}</MasterDetailPaneContext.Provider>
        </div>
      </div>
    </MasterDetailListSearchContext.Provider>
  );
}

/**
 * The record pane's content at a section's index address on desktop: shown
 * only while the first record is opening, or when the list is empty.
 */
export function MasterDetailNoSelection({
  message,
}: {
  /** Overrides the default "Choose a record from the list." */
  readonly message?: string;
}) {
  const t = usePageCopy();
  return (
    <p data-slot="master-detail-no-selection" className="text-muted-foreground text-sm">
      {message ?? t("page.masterDetail.noSelection")}
    </p>
  );
}

function subscribeToDesktopWidth(onChange: () => void): () => void {
  const query = readDesktopWidthQuery();
  if (query === null) return () => undefined;
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function readIsDesktopWidth(): boolean {
  return readDesktopWidthQuery()?.matches ?? false;
}

function readIsDesktopWidthOnServer(): boolean {
  return false;
}

function readDesktopWidthQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(MASTER_DETAIL_DESKTOP_QUERY);
}
