import {
  type ColumnDef,
  type ColumnPinningState,
  functionalUpdate,
  type Updater,
  type VisibilityState,
} from "@tanstack/react-table";
import * as React from "react";

import {
  defaultColumnPinning,
  pickReaderVisibility,
  readHideableColumnIds,
  withColumnRoles,
} from "../lib/column-roles.js";
import {
  readBrowserStorage,
  readStoredColumnVisibility,
  writeStoredColumnVisibility,
} from "../lib/column-visibility-storage.js";

/** The column layout `useDataTable` hands TanStack: roles, pins, and visibility. */
export type ReaderColumnLayout<TData> = {
  readonly columns: ColumnDef<TData>[];
  readonly defaultPinning: ColumnPinningState;
  readonly columnVisibility: VisibilityState;
  readonly onColumnVisibilityChange: (updaterOrValue: Updater<VisibilityState>) => void;
};

/**
 * Which columns show and where they pin. The identifying, selection, and
 * actions columns can never be hidden; the reader hides the rest, starting
 * from the page's `initialVisibility` overlaid with what the reader chose for
 * `tableId` last time, and every change is remembered for `tableId`.
 */
export function useReaderColumnLayout<TData>({
  callerColumns,
  initialVisibility,
  tableId,
}: {
  readonly callerColumns: readonly ColumnDef<TData>[];
  readonly initialVisibility: VisibilityState | undefined;
  readonly tableId: string | undefined;
}): ReaderColumnLayout<TData> {
  const columns = React.useMemo(() => withColumnRoles(callerColumns), [callerColumns]);
  const hideableColumnIds = React.useMemo(() => readHideableColumnIds(columns), [columns]);
  const defaultPinning = React.useMemo(() => defaultColumnPinning(columns), [columns]);

  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() => ({
    ...initialVisibility,
    ...readStoredColumnVisibility(readBrowserStorage(), tableId),
  }));

  const onColumnVisibilityChange = React.useCallback(
    (updaterOrValue: Updater<VisibilityState>) => {
      const next = functionalUpdate(updaterOrValue, columnVisibility);
      setColumnVisibility(next);
      writeStoredColumnVisibility(readBrowserStorage(), tableId, pickReaderVisibility(next, hideableColumnIds));
    },
    [columnVisibility, hideableColumnIds, tableId],
  );

  return {
    columns,
    defaultPinning,
    columnVisibility,
    onColumnVisibilityChange,
  };
}
