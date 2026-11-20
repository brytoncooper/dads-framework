/**
 * What: every table scrolls sideways in its own container and softly fades
 * each edge while more columns lie past it; `stickyFirstColumn` keeps the first cell of
 * each row in view on an opaque surface that still takes row states.
 * Why: tables hold business records, so no column may drop out of sight for
 * lack of width — an off-screen column must be visibly there, a swipe away.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.js";

afterEach(() => {
  cleanup();
});

function WideTable({
  stickyFirstColumn = false,
  trailingPinnedWidth,
}: {
  readonly stickyFirstColumn?: boolean;
  readonly trailingPinnedWidth?: number;
}) {
  return (
    <Table
      stickyFirstColumn={stickyFirstColumn}
      {...(trailingPinnedWidth === undefined ? {} : { trailingPinnedWidth })}
    >
      <TableHeader>
        <TableRow>
          <TableHead>Ticket</TableHead>
          <TableHead>Carrier</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>T-1001</TableCell>
          <TableCell>Prairie Freight</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function setScrollMetrics(
  element: Element,
  metrics: { scrollLeft: number; clientWidth: number; scrollWidth: number },
): void {
  for (const [name, value] of Object.entries(metrics)) {
    Object.defineProperty(element, name, { configurable: true, value });
  }
}

function scroller(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    '[data-slot="table-container"]',
  );
  if (!element) throw new Error("Expected the table container.");
  return element;
}

function fade(
  container: HTMLElement,
  edge: "left" | "right",
): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-slot="table-edge-fade"][data-edge="${edge}"]`,
  );
}

function isShown(element: HTMLElement | null): boolean {
  return element?.hasAttribute("data-visible") ?? false;
}

describe("Table horizontal overflow", () => {
  it("scrolls sideways inside its own container with no text affordance", () => {
    const { container } = render(<WideTable />);

    expect(scroller(container).className).toContain("overflow-x-auto");
    expect(screen.queryByRole("button")).toBeNull();
    expect(isShown(fade(container, "left"))).toBe(false);
    expect(isShown(fade(container, "right"))).toBe(false);
  });

  it("fades each edge only while content lies past it", () => {
    const { container } = render(<WideTable trailingPinnedWidth={120} />);
    const element = scroller(container);
    const left = fade(container, "left");
    const right = fade(container, "right");

    expect(right?.getAttribute("aria-hidden")).toBe("true");
    expect(right?.className).toContain("pointer-events-none");
    expect(right?.className).toContain("absolute");
    expect(right?.className).toContain("motion-reduce:transition-none");
    expect(right?.style.right).toBe("120px");

    setScrollMetrics(element, {
      scrollLeft: 0,
      clientWidth: 400,
      scrollWidth: 900,
    });
    fireEvent.scroll(element);
    expect(isShown(left)).toBe(false);
    expect(isShown(right)).toBe(true);

    setScrollMetrics(element, {
      scrollLeft: 200,
      clientWidth: 400,
      scrollWidth: 900,
    });
    fireEvent.scroll(element);
    expect(isShown(left)).toBe(true);
    expect(isShown(right)).toBe(true);

    setScrollMetrics(element, {
      scrollLeft: 500,
      clientWidth: 400,
      scrollWidth: 900,
    });
    fireEvent.scroll(element);
    expect(isShown(left)).toBe(true);
    expect(isShown(right)).toBe(false);
  });

  it("leaves the left edge to the sticky first column's own shadow", () => {
    const { container } = render(<WideTable stickyFirstColumn />);

    expect(fade(container, "left")).toBeNull();
    expect(fade(container, "right")).not.toBeNull();
  });
});

describe("Table stickyFirstColumn", () => {
  it("pins the first header and body cell on opaque surfaces", () => {
    const { container } = render(<WideTable stickyFirstColumn />);

    expect(
      container
        .querySelector('[data-slot="table"]')
        ?.hasAttribute("data-sticky-first-column"),
    ).toBe(true);
    const head = screen.getByRole("columnheader", { name: "Ticket" });
    const cell = screen.getByRole("cell", { name: "T-1001" });
    expect(head.className).toContain("first:sticky");
    expect(head.className).toContain("first:bg-table-header");
    expect(cell.className).toContain("first:sticky");
    expect(cell.className).toContain("first:left-0");
    expect(cell.className).toContain("first:bg-card");

    const row = cell.closest('[data-slot="table-row"]');
    expect(row?.className).toContain("hover:[&>td]:bg-table-row-hover");
    expect(row?.className).toContain(
      "data-[state=selected]:[&>td]:bg-table-row-selected",
    );
  });

  it("leaves cells unpinned by default", () => {
    render(<WideTable />);

    expect(
      screen.getByRole("cell", { name: "T-1001" }).className,
    ).not.toContain("first:sticky");
  });
});
