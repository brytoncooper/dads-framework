// @vitest-environment jsdom
/** Server-selected page sizes remain visible even when absent from the suggested picker choices. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDataTable } from "../../hooks/use-data-table.js";
import { defaultDataTableState } from "../../lib/data-table-search-params.js";
import { DataTablePagination } from "./data-table-pagination.js";

afterEach(cleanup);

describe("DataTablePagination current page size", () => {
  it.each([25, 75, 20])(
    "displays the actual %i rows per page without altering the selected server query",
    (perPage) => {
      render(<Pagination perPage={perPage} />);
      expect(
        screen.getByRole("combobox", { name: "Rows per Page" }).textContent,
      ).toBe(String(perPage));
    },
  );
});

function Pagination({ perPage }: { readonly perPage: number }) {
  const { table } = useDataTable({
    data: [{ id: "recipe" }],
    columns: [{ accessorKey: "id" }],
    pageCount: 3,
    state: { ...defaultDataTableState, perPage },
    onStateChange: () => undefined,
  });
  return <DataTablePagination table={table} />;
}
