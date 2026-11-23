/**
 * What: DataTable operator and sort configuration carries typed copy keys.
 * Why: English labels in pure configuration cannot be translated, and resolving
 * them there would couple locale-dependent grammar to non-React logic.
 */
import { describe, expect, it } from "vitest";
import { getFilterOperators } from "../lib/data-table.js";
import { dataTableConfig } from "./data-table.js";

describe("DataTable configuration copy ownership", () => {
  it("describes filter operators with copy keys instead of English labels", () => {
    expect(dataTableConfig.textOperators[0]).toEqual({
      labelKey: "dataTable.operator.contains",
      value: "iLike",
    });
    expect(getFilterOperators("date")[2]).toEqual({
      labelKey: "dataTable.operator.isBefore",
      value: "lt",
    });
    expect(dataTableConfig.textOperators.some((operator) => "label" in operator)).toBe(false);
  });

  it("describes sort directions with copy keys instead of English labels", () => {
    expect(dataTableConfig.sortOrders).toEqual([
      { labelKey: "dataTable.sort.ascending", value: "asc" },
      { labelKey: "dataTable.sort.descending", value: "desc" },
    ]);
  });
});
