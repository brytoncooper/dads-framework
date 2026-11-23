import type { ColumnDef, ColumnPinningState, VisibilityState } from "@tanstack/react-table";

/** The column ids a row-selection checkbox column uses by convention. */
const SELECTION_COLUMN_IDS: ReadonlySet<string> = new Set(["select", "selection"]);

/** Whether `id` names a row-selection checkbox column ("select" or "selection"). */
export function isSelectionColumnId(id: string | undefined): boolean {
  return id !== undefined && SELECTION_COLUMN_IDS.has(id);
}

/** The column id a row's trailing actions use by convention. */
export const ACTIONS_COLUMN_ID = "actions";

/**
 * The id TanStack gives a column definition: its `id`, else its string
 * `accessorKey`. Undefined for a definition with neither (TanStack rejects it).
 */
export function readColumnDefId<TData>(column: ColumnDef<TData>): string | undefined {
  if (column.id !== undefined) return column.id;
  if ("accessorKey" in column && typeof column.accessorKey === "string") {
    return column.accessorKey;
  }
  return undefined;
}

/**
 * The column that names each row — the first one that is not the selection
 * checkbox. It is pinned left on wide screens, heads each card on phones, and
 * can never be hidden.
 */
export function readIdentifyingColumnId<TData>(columns: readonly ColumnDef<TData>[]): string | undefined {
  return columns.map((column) => readColumnDefId(column)).find((id) => id !== undefined && !isSelectionColumnId(id));
}

/**
 * The same definitions with hiding switched off for the columns a reader may
 * never hide: the identifying column, the selection checkbox, and the actions.
 */
export function withColumnRoles<TData>(columns: readonly ColumnDef<TData>[]): ColumnDef<TData>[] {
  const identifyingId = readIdentifyingColumnId(columns);
  return columns.map((column) => {
    const id = readColumnDefId(column);
    const alwaysShown = id === identifyingId || isSelectionColumnId(id) || id === ACTIONS_COLUMN_ID;
    return alwaysShown ? { ...column, enableHiding: false } : column;
  });
}

/**
 * Pin the selection checkbox and the identifying column left, and the actions
 * column right, so a row stays recognisable and actionable while the columns
 * between them scroll sideways.
 */
export function defaultColumnPinning<TData>(columns: readonly ColumnDef<TData>[]): ColumnPinningState {
  const ids = columns.flatMap((column) => readColumnDefId(column) ?? []);
  const identifyingId = readIdentifyingColumnId(columns);
  const left = [
    ...ids.filter((id) => isSelectionColumnId(id)),
    ...(identifyingId === undefined ? [] : [identifyingId]),
  ];
  const right = ids.includes(ACTIONS_COLUMN_ID) ? [ACTIONS_COLUMN_ID] : [];
  return { left, right };
}

/** Ids of the columns a reader may hide, given definitions from `withColumnRoles`. */
export function readHideableColumnIds<TData>(columns: readonly ColumnDef<TData>[]): ReadonlySet<string> {
  return new Set(
    columns.flatMap((column) => {
      const id = readColumnDefId(column);
      return id !== undefined && column.enableHiding !== false ? [id] : [];
    }),
  );
}

/** Only the visibility entries a reader controls — what is worth remembering. */
export function pickReaderVisibility(visibility: VisibilityState, hideableIds: ReadonlySet<string>): VisibilityState {
  return Object.fromEntries(Object.entries(visibility).filter(([id]) => hideableIds.has(id)));
}

/** `visibility` with every column the reader may hide shown again. */
export function showEveryHideableColumn(visibility: VisibilityState, hideableIds: Iterable<string>): VisibilityState {
  const shown = Object.fromEntries([...hideableIds].map((id) => [id, true] as const));
  return { ...visibility, ...shown };
}
