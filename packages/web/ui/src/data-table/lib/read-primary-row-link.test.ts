/**
 * What: find the visible row link and which cell owns it.
 * Why: Safari cannot use a table row as a containing block, so extra hit
 * areas must copy that href onto the other cells of the same row.
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import {
  readPrimaryRowLink,
  samePrimaryRowLink,
} from "./read-primary-row-link.js";

function rowWithLinks(markup: string): HTMLTableRowElement {
  const table = document.createElement("table");
  table.innerHTML = `<tbody><tr data-slot="table-row">${markup}</tr></tbody>`;
  const row = table.querySelector("tr");
  if (!row) {
    throw new Error("expected a table row");
  }
  return row;
}

describe("readPrimaryRowLink", () => {
  it("returns the first real link and the cell that owns it", () => {
    const row = rowWithLinks(
      `<td data-slot="table-cell"><a href="/mills/north">North</a></td>
       <td data-slot="table-cell">ACTIVE</td>`,
    );

    expect(readPrimaryRowLink(row)).toEqual({
      href: "/mills/north",
      cellIndex: 0,
    });
  });

  it("ignores hit areas already stamped onto other cells", () => {
    const row = rowWithLinks(
      `<td data-slot="table-cell"><a href="/mills/north">North</a></td>
       <td data-slot="table-cell">
         ACTIVE
         <a data-slot="data-table-row-hit-area" href="/mills/north"></a>
       </td>`,
    );

    expect(readPrimaryRowLink(row)).toEqual({
      href: "/mills/north",
      cellIndex: 0,
    });
  });

  it("treats matching href and cell as the same link", () => {
    expect(
      samePrimaryRowLink(
        { href: "/mills/north", cellIndex: 0 },
        { href: "/mills/north", cellIndex: 0 },
      ),
    ).toBe(true);
    expect(
      samePrimaryRowLink(
        { href: "/mills/north", cellIndex: 0 },
        { href: "/mills/south", cellIndex: 0 },
      ),
    ).toBe(false);
  });

  it("returns nothing when the row has no link", () => {
    const row = rowWithLinks(
      `<td data-slot="table-cell">North</td>
       <td data-slot="table-cell">ACTIVE</td>`,
    );

    expect(readPrimaryRowLink(row)).toBeNull();
  });
});
