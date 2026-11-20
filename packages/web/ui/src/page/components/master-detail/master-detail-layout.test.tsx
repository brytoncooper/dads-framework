/** @vitest-environment jsdom */
// Desktop shows the rail beside the record; a phone shows the list at the index address and the record once one is named.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  MasterDetailLayout,
  MasterDetailNoSelection,
  useInMasterDetailPane,
} from "./master-detail-layout.js";

afterEach(cleanup);

function PaneProbe() {
  return <p>{useInMasterDetailPane() ? "in pane" : "outside pane"}</p>;
}

function panes() {
  const rail = screen.getByRole("complementary", { name: "Assets" });
  const record = rail.parentElement?.querySelector(
    '[data-slot="master-detail-record-pane"]',
  );
  return { rail, record };
}

describe("MasterDetailLayout", () => {
  it("shows only the list on a phone at the index address, and both panes on desktop", () => {
    render(
      <MasterDetailLayout
        label="Assets"
        selected={false}
        listSearch={{}}
        rail={<p>rows</p>}
      >
        <MasterDetailNoSelection />
      </MasterDetailLayout>,
    );
    const { rail, record } = panes();
    expect(rail.className.split(" ")).toContain("flex");
    expect(rail.className).toContain("lg:flex");
    expect(record?.className.split(" ")).toContain("hidden");
    expect(record?.className).toContain("lg:flex");
  });

  it("shows only the record on a phone once the address names one", () => {
    render(
      <MasterDetailLayout
        label="Assets"
        selected
        listSearch={{}}
        rail={<p>rows</p>}
      >
        <p>record</p>
      </MasterDetailLayout>,
    );
    const { rail, record } = panes();
    expect(rail.className.split(" ")).toContain("hidden");
    expect(rail.className).toContain("lg:flex");
    expect(record?.className.split(" ")).toContain("flex");
  });

  it("fills the space the workspace shell leaves it instead of sizing itself to the viewport", () => {
    const { container } = render(
      <MasterDetailLayout
        label="Assets"
        selected={false}
        listSearch={{}}
        rail={<p>rows</p>}
      >
        <p>record</p>
      </MasterDetailLayout>,
    );
    const frame = container.querySelector('[data-slot="master-detail"]');
    const frameClasses = frame?.className.split(" ") ?? [];
    expect(frame?.className).not.toMatch(/dvh|svh|vh\]/);
    expect(frameClasses).toContain("flex-1");
    expect(frameClasses).toContain("min-h-0");
    expect(frameClasses).toContain("lg:grid-rows-[minmax(0,1fr)]");
    expect(frameClasses).toContain("lg:overflow-hidden");
    const { rail, record } = panes();
    expect(rail.className).not.toMatch(/dvh|svh|vh\]/);
    expect(rail.className.split(" ")).toContain("min-h-0");
    expect(rail.className.split(" ")).toContain("overflow-hidden");
    expect(record?.className.split(" ")).toContain("min-h-0");
    expect(record?.className.split(" ")).toContain("overflow-y-auto");
  });

  it("gives the rail the sidebar's 18rem column on desktop", () => {
    const { container } = render(
      <MasterDetailLayout
        label="Assets"
        selected={false}
        listSearch={{}}
        rail={<p>rows</p>}
      >
        <p>record</p>
      </MasterDetailLayout>,
    );
    const frame = container.querySelector('[data-slot="master-detail"]');
    expect(frame?.className.split(" ")).toContain(
      "lg:grid-cols-[18rem_minmax(0,1fr)]",
    );
  });

  it("asks the shell for the whole viewport, with the record pane scrolling on a phone too", () => {
    for (const selected of [false, true]) {
      const { container, unmount } = render(
        <MasterDetailLayout
          label="Assets"
          selected={selected}
          listSearch={{}}
          rail={<p>rows</p>}
        >
          <p>record</p>
        </MasterDetailLayout>,
      );
      expect(
        container
          .querySelector('[data-slot="master-detail"]')
          ?.hasAttribute("data-fills-viewport"),
      ).toBe(true);
      expect(panes().record?.className.split(" ")).toEqual(
        expect.arrayContaining(["flex-1", "overflow-y-auto", "p-4"]),
      );
      unmount();
    }
  });

  it("tells the record pane's children they are inside it", () => {
    render(
      <>
        <MasterDetailLayout
          label="Assets"
          selected
          listSearch={{}}
          rail={<PaneProbe />}
        >
          <PaneProbe />
        </MasterDetailLayout>
        <PaneProbe />
      </>,
    );
    expect(screen.getAllByText("in pane")).toHaveLength(1);
    expect(screen.getAllByText("outside pane")).toHaveLength(2);
  });

  it("explains an empty record pane", () => {
    render(<MasterDetailNoSelection />);
    expect(screen.getByText("Choose a record from the list.")).toBeTruthy();
  });
});
