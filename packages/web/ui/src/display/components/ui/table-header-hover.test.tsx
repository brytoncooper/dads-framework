/**
 * What: table header cells and the header row do not take the row hover wash.
 * Why: the header is structure, not a data row; a blue tinge on a column label
 * reads as a highlight the operator cannot act on.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from "./table.js";

afterEach(cleanup);

describe("table header hover", () => {
  it("keeps the header band still while body rows keep the highlight", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Corn</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const header = document.querySelector('[data-slot="table-header"]');
    const headerCell = screen.getByRole("columnheader", { name: "Name" });
    const bodyCell = screen.getByRole("cell", { name: "Corn" });
    const bodyRow = bodyCell.closest('[data-slot="table-row"]');

    expect(header?.className).not.toContain("hover:bg-table-row-hover");
    expect(headerCell.className).not.toContain("hover:bg-table-row-hover");
    expect(bodyRow?.className).toContain("hover:[&>td]:bg-table-row-hover");
    expect(bodyRow?.className.split(/\s+/)).not.toContain(
      "hover:bg-table-row-hover",
    );
    expect(bodyCell.className.split(/\s+/)).toContain("relative");
  });
});
