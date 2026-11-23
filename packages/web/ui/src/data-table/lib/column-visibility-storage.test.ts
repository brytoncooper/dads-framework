/**
 * What: a named table remembers the reader's column choice; unusable or
 * failing storage reads as no choice and never throws.
 * Why: a reader who hid columns expects them hidden next visit, and a blocked
 * or corrupted store must never take the table down with it.
 */
import { describe, expect, it } from "vitest";

import {
  type ColumnVisibilityStorage,
  columnVisibilityStorageKey,
  readStoredColumnVisibility,
  writeStoredColumnVisibility,
} from "./column-visibility-storage.js";

function memoryStorage(): ColumnVisibilityStorage & {
  readonly items: Map<string, string>;
} {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const THROWING_STORAGE: ColumnVisibilityStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("column visibility storage", () => {
  it("round-trips a named table's choice", () => {
    const storage = memoryStorage();
    writeStoredColumnVisibility(storage, "orders", { carrier: false });

    expect(storage.items.has("dads.data-table.orders.column-visibility")).toBe(true);
    expect(readStoredColumnVisibility(storage, "orders")).toEqual({
      carrier: false,
    });
  });

  it("keeps nothing for a table without an id", () => {
    const storage = memoryStorage();
    writeStoredColumnVisibility(storage, undefined, { carrier: false });

    expect(storage.items.size).toBe(0);
    expect(readStoredColumnVisibility(storage, undefined)).toEqual({});
  });

  it("reads malformed values as no choice", () => {
    const storage = memoryStorage();
    storage.setItem(columnVisibilityStorageKey("orders"), "not json");
    expect(readStoredColumnVisibility(storage, "orders")).toEqual({});

    storage.setItem(columnVisibilityStorageKey("orders"), JSON.stringify({ carrier: false, status: "no" }));
    expect(readStoredColumnVisibility(storage, "orders")).toEqual({
      carrier: false,
    });

    storage.setItem(columnVisibilityStorageKey("orders"), "[false]");
    expect(readStoredColumnVisibility(storage, "orders")).toEqual({});
  });

  it("survives storage that throws", () => {
    expect(readStoredColumnVisibility(THROWING_STORAGE, "orders")).toEqual({});
    expect(() => {
      writeStoredColumnVisibility(THROWING_STORAGE, "orders", {});
    }).not.toThrow();
  });
});
