/**
 * What: shared empty copy and horizontal tabs keep truthful semantics at every
 * viewport width.
 * Why: descriptions promised paragraph props while rendering a div, and four
 * fixed-width tabs could push a narrow page wider than its viewport.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyDescription } from "./empty.js";
import { Tabs, TabsList, TabsTrigger } from "./tabs.js";

afterEach(cleanup);

describe("display semantics", () => {
  it("renders empty-state descriptive copy as a paragraph", () => {
    render(<EmptyDescription>Nothing matches these filters.</EmptyDescription>);

    expect(screen.getByText("Nothing matches these filters.").tagName).toBe("P");
  });

  it("keeps a horizontal tab list inside narrow viewports with scrolling", () => {
    render(
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="availability">Availability</TabsTrigger>
          <TabsTrigger value="formulation">Formulation</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const tabList = screen.getByRole("tablist");
    expect(tabList.className).toContain("max-w-full");
    expect(tabList.className).toContain("overflow-x-auto");

    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("shrink-0");
    }
  });
});
