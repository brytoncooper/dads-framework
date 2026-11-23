/**
 * What: a filter pill reads "Type" while unset and "Type: Sales, Transfers"
 * once set, and its popover changes the selection through a checkbox list, or
 * a radio list for a single-value group.
 * Why: the pill is the only visible sign of a secondary narrowing on a wide
 * screen; if it hid what is chosen or changed the wrong values, the list
 * would look unfiltered while it is not.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilterPill } from "./filter-pill.js";

const OPTIONS = [
  { value: "SALE", label: "Sales" },
  { value: "PURCHASE", label: "Purchases" },
  { value: "TRANSFER", label: "Transfers" },
];

afterEach(cleanup);

function TypePill({ initial = [], multiple }: { readonly initial?: readonly string[]; readonly multiple?: boolean }) {
  const [selected, setSelected] = React.useState<readonly string[]>(initial);
  return (
    <FilterPill
      label="Type"
      options={OPTIONS}
      selected={selected}
      onSelectedChange={setSelected}
      {...(multiple === undefined ? {} : { multiple })}
    />
  );
}

describe("FilterPill", () => {
  it("reads as a dashed axis name while nothing is chosen", () => {
    render(<TypePill />);

    const pill = screen.getByRole("button", { name: "Type" });
    expect(pill.className).toContain("border-dashed");
    expect(pill.className).not.toContain("border-primary");
  });

  it("names every chosen value and turns solid and primary once set", () => {
    render(<TypePill initial={["TRANSFER", "SALE"]} />);

    const pill = screen.getByRole("button", { name: "Type: Sales, Transfers" });
    expect(pill.className).toContain("border-solid");
    expect(pill.className).toContain("border-primary");
  });

  it("toggles values from its checkbox list", () => {
    render(<TypePill />);

    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Transfers" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Sales" }));

    expect(screen.getByRole("button", { name: "Type: Sales, Transfers" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Sales" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("checkbox", { name: "Sales" }));
    expect(screen.getByRole("button", { name: "Type: Transfers" })).toBeDefined();
  });

  it("offers a radio list when the group takes one value", () => {
    const onSelectedChange = vi.fn();
    render(
      <FilterPill
        label="Direction"
        options={[
          { value: "IN", label: "Inbound" },
          { value: "OUT", label: "Outbound" },
        ]}
        selected={["IN"]}
        onSelectedChange={onSelectedChange}
        multiple={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Direction: Inbound" }));
    expect(screen.getByRole("radiogroup", { name: "Direction" })).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Outbound" }));
    expect(onSelectedChange).toHaveBeenCalledWith(["OUT"]);
  });

  it("narrows a searchable list as the reader types, keeping chosen values", () => {
    render(
      <FilterPill
        label="Company"
        options={[
          { value: "a", label: "Snake River Aggregates" },
          { value: "b", label: "Teton Ready Mix" },
          { value: "c", label: "Cascade Materials" },
        ]}
        selected={["c"]}
        onSelectedChange={() => undefined}
        searchable
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Company: Cascade Materials" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Company" }), {
      target: { value: "teton" },
    });

    expect(screen.getByRole("checkbox", { name: "Teton Ready Mix" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Cascade Materials" })).toBeDefined();
    expect(screen.queryByRole("checkbox", { name: "Snake River Aggregates" })).toBeNull();
  });

  it("shows a default view chosen in the radio list without making the pill look filtered", () => {
    render(
      <FilterPill
        label="Status"
        options={[
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
        ]}
        selected={[]}
        defaultValue="active"
        onSelectedChange={vi.fn()}
        multiple={false}
      />,
    );

    const pill = screen.getByRole("button", { name: "Status" });
    expect(pill.className).toContain("border-dashed");
    fireEvent.click(pill);
    expect(screen.getByRole("radio", { name: "Active" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Archived" }).getAttribute("aria-checked")).toBe("false");
  });
});
