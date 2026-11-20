import type { VisibilityState } from "@tanstack/react-table";

/** The slice of `Storage` column visibility needs, so tests pass a plain object. */
export type ColumnVisibilityStorage = Pick<Storage, "getItem" | "setItem">;

/** Where one table's reader-chosen column visibility is remembered. */
export function columnVisibilityStorageKey(tableId: string): string {
  return ["dads", "data-table", tableId, "column-visibility"].join(".");
}

/**
 * The column visibility a reader chose for `tableId` last time, or an empty
 * state when nothing usable is stored. Storage that throws (private mode,
 * blocked site data) or holds anything but `{ [columnId]: boolean }` reads as
 * nothing chosen, never as an error.
 */
export function readStoredColumnVisibility(
  storage: ColumnVisibilityStorage | null,
  tableId: string | undefined,
): VisibilityState {
  if (storage === null || tableId === undefined) return {};
  try {
    const raw = storage.getItem(columnVisibilityStorageKey(tableId));
    return raw === null ? {} : parseColumnVisibility(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Remember the reader's column visibility for `tableId`. A table without an id
 * keeps the choice for this visit only; a storage failure is ignored, because
 * losing a preference must never break the table.
 */
export function writeStoredColumnVisibility(
  storage: ColumnVisibilityStorage | null,
  tableId: string | undefined,
  visibility: VisibilityState,
): void {
  if (storage === null || tableId === undefined) return;
  try {
    storage.setItem(
      columnVisibilityStorageKey(tableId),
      JSON.stringify(visibility),
    );
  } catch {
    return;
  }
}

/** The browser's `localStorage`, or null where reading it throws or it is absent. */
export function readBrowserStorage(): ColumnVisibilityStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseColumnVisibility(value: unknown): VisibilityState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}
