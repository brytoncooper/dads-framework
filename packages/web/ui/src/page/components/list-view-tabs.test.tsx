/**
 * What: a list page's one row of views — tabs with the active one marked and
 * announced, counts only where the caller gives one, and arrow, Home, and End
 * keys that move and choose with a single tab stop.
 * Why: the views are the first thing a reader uses to find their work; a
 * row that hid the active view, showed a count nobody computed, or trapped
 * keyboard users in a tab per view would undo the pattern's point.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { type ListView, ListViewTabs } from "./list-view-tabs.js";

type Status = "OPEN" | "DRAFT" | "CLOSED" | "ALL";

const VIEWS: readonly ListView<Status>[] = [
  { value: "OPEN", label: "Open", count: 12 },
  { value: "DRAFT", label: "Draft", count: 1400 },
  { value: "CLOSED", label: "Closed" },
  { value: "ALL", label: "All" },
];

afterEach(cleanup);

function StatusTabs({ initial = "OPEN" }: { readonly initial?: Status }) {
  const [value, setValue] = React.useState<Status>(initial);
  return (
    <ListViewTabs label="Order Status" views={VIEWS} value={value} onValueChange={setValue} controls="orders-list" />
  );
}

function selectedName(): string | null {
  return screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? null;
}

describe("ListViewTabs", () => {
  it("names the row and marks only the active view", () => {
    render(<StatusTabs />);

    expect(screen.getByRole("tablist", { name: "Order Status" })).toBeDefined();
    const open = screen.getByRole("tab", { name: "Open 12" });
    expect(open.getAttribute("aria-selected")).toBe("true");
    expect(open.getAttribute("aria-controls")).toBe("orders-list");
    expect(open.className).toContain("border-primary");
    expect(open.className).toContain("font-semibold");

    const draft = screen.getByRole("tab", { name: "Draft 1,400" });
    expect(draft.getAttribute("aria-selected")).toBe("false");
    expect(draft.getAttribute("aria-controls")).toBeNull();
    expect(draft.className).not.toContain("border-primary");
  });

  it("shows a count only where the caller supplies one", () => {
    const { container } = render(<StatusTabs />);

    const counts = [...container.querySelectorAll('[data-slot="list-view-count"]')];
    expect(counts.map((count) => count.textContent)).toEqual(["12", "1,400"]);
    expect(counts[0]?.className).toContain("text-link");
    expect(counts[1]?.className).not.toContain("text-link");
    expect(screen.getByRole("tab", { name: "Closed" })).toBeDefined();
  });

  it("tints a count destructive only when the view asks for the critical tone", () => {
    const { container } = render(
      <ListViewTabs
        label="Order Status"
        views={[
          { value: "OPEN", label: "Open", count: 3, countTone: "critical" },
          { value: "DRAFT", label: "Draft", count: 5 },
        ]}
        value="OPEN"
        onValueChange={() => undefined}
      />,
    );

    const counts = [...container.querySelectorAll('[data-slot="list-view-count"]')];
    expect(counts[0]?.className).toContain("text-destructive");
    expect(counts[1]?.className).not.toContain("text-destructive");
  });

  it("chooses a view on click", () => {
    render(<StatusTabs />);

    fireEvent.click(screen.getByRole("tab", { name: "Closed" }));
    expect(selectedName()).toBe("Closed");
  });

  it("keeps one tab stop and moves with arrows, Home, and End, wrapping at the ends", () => {
    render(<StatusTabs />);

    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Open 12" }), {
      key: "ArrowRight",
    });
    expect(selectedName()).toBe("Draft 1,400");
    expect(document.activeElement?.textContent).toBe("Draft 1,400");

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "End",
    });
    expect(selectedName()).toBe("All");

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "ArrowRight",
    });
    expect(selectedName()).toBe("Open 12");

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "ArrowLeft",
    });
    expect(selectedName()).toBe("All");

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Home",
    });
    expect(selectedName()).toBe("Open 12");
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
  });

  it("keeps the row on one line that scrolls sideways on a phone", () => {
    render(<StatusTabs />);

    const row = screen.getByRole("tablist").className;
    expect(row).toContain("overflow-x-auto");
    expect(row).not.toContain("flex-wrap");
    expect(row).toContain("max-md:[mask-image");
  });
});
