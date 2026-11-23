/** @vitest-environment jsdom */
// The rail stacks its controls above a Name header that toggles the URL sort, and its segmented filters always keep one choice.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MasterDetailRail,
  MasterDetailRailHeader,
  MasterDetailSegmentedFilter,
  MasterDetailSortHeader,
} from "./master-detail-rail.js";

afterEach(cleanup);

describe("MasterDetailRail", () => {
  it("orders header, controls, sort header and rows top to bottom", () => {
    render(
      <MasterDetailRail
        header={<MasterDetailRailHeader title="Assets" />}
        controls={<input aria-label="Search Assets" />}
        sortHeader={<MasterDetailSortHeader sort="name" onSortChange={vi.fn()} />}
      >
        <p>rows</p>
      </MasterDetailRail>,
    );
    const order = [
      screen.getByRole("heading", { name: "Assets" }),
      screen.getByRole("textbox", { name: "Search Assets" }),
      screen.getByRole("button", { name: /^Sort by Name/ }),
      screen.getByText("rows"),
    ];
    for (let index = 1; index < order.length; index += 1) {
      const previous = order[index - 1];
      const current = order[index];
      if (previous === undefined || current === undefined) continue;
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("MasterDetailRail controls", () => {
  it("wraps controls so adjacent filter pills share a row instead of stretching", () => {
    render(
      <MasterDetailRail
        controls={
          <>
            <input aria-label="Search Assets" className="w-full" />
            <button type="button">Facility</button>
            <button type="button">Status</button>
          </>
        }
      >
        <p>rows</p>
      </MasterDetailRail>,
    );
    const controls = screen.getByRole("textbox", {
      name: "Search Assets",
    }).parentElement;
    expect(controls?.getAttribute("data-slot")).toBe("master-detail-rail-controls");
    expect(controls?.className).toContain("flex-wrap");
    expect(controls?.className).not.toContain("flex-col");
  });
});

describe("MasterDetailSortHeader", () => {
  it("flips an ascending name sort to descending", () => {
    const onSortChange = vi.fn();
    render(<MasterDetailSortHeader sort="name" onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name, descending" }));
    expect(onSortChange).toHaveBeenCalledWith("-name");
  });

  it("flips a descending name sort back to ascending", () => {
    const onSortChange = vi.fn();
    render(<MasterDetailSortHeader sort="-name" onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name, ascending" }));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it("starts ascending when the list is sorted by another key", () => {
    const onSortChange = vi.fn();
    render(<MasterDetailSortHeader sort="-createdAt" onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole("button", { name: /ascending$/ }));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });
});

describe("MasterDetailSegmentedFilter", () => {
  const options = [
    { value: "all", label: "All" },
    { value: "needs-setup", label: "Tag Needed", count: 4 },
  ] as const;

  it("shows counts after labels and reports a new choice", () => {
    const onValueChange = vi.fn();
    render(<MasterDetailSegmentedFilter label="Setup" options={options} value="all" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Tag Needed (4)" }));
    expect(onValueChange).toHaveBeenCalledWith("needs-setup");
  });

  it("keeps the current choice when it is pressed again", () => {
    const onValueChange = vi.fn();
    render(<MasterDetailSegmentedFilter label="Setup" options={options} value="all" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
