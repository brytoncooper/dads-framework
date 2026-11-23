import { describe, expect, it } from "vitest";

import { assertCatalogParity, mergeCopy, translate } from "../../copy/index.js";

import { dataTableCopy } from "./data-table-copy.js";

/**
 * What: DataTable owns complete English chrome, dynamic phrases, and plural
 * selection for both visible controls and screen-reader announcements.
 * Why: shared tables must not rebuild English grammar at their render edges.
 */
describe("dataTableCopy", () => {
  it("has every supported locale for every phrase", () => {
    const merged = mergeCopy([
      {
        file: "copy/data-table-copy.ts",
        entries: dataTableCopy,
      },
    ]);

    expect(() => {
      assertCatalogParity(merged);
    }).not.toThrow();
  });

  it("preserves the established Title Case control labels", () => {
    expect(
      translate(dataTableCopy, "en", "dataTable.action.resetFilters"),
    ).toBe("Reset Filters");
    expect(
      translate(dataTableCopy, "en", "dataTable.pagination.rowsPerPage"),
    ).toBe("Rows per Page");
    expect(
      translate(dataTableCopy, "en", "dataTable.filter.heading.empty"),
    ).toBe("No Filters Applied");
    expect(translate(dataTableCopy, "en", "dataTable.sort.heading.empty")).toBe(
      "No Sorting Applied",
    );
    expect(
      translate(dataTableCopy, "en", "dataTable.sort.heading.active"),
    ).toBe("Sort By");
  });

  it("resolves whole dynamic and plural phrases", () => {
    expect(
      translate(
        dataTableCopy,
        "en",
        "dataTable.pagination.selectedRows",
        { totalCount: 8 },
        1,
      ),
    ).toBe("1 of 8 row selected.");
    expect(
      translate(
        dataTableCopy,
        "en",
        "dataTable.pagination.selectedRows",
        { totalCount: 8 },
        3,
      ),
    ).toBe("3 of 8 rows selected.");
    expect(
      translate(dataTableCopy, "en", "dataTable.columns.hiddenCount", {}, 1),
    ).toBe("1 Column Hidden");
    expect(
      translate(dataTableCopy, "en", "dataTable.columns.hiddenCount", {}, 4),
    ).toBe("4 Columns Hidden");
    expect(
      translate(dataTableCopy, "en", "dataTable.sortable.movedDown", {
        itemId: "status",
        position: 2,
        total: 4,
      }),
    ).toBe('Item "status" moved down to position 2 of 4.');
  });
});
