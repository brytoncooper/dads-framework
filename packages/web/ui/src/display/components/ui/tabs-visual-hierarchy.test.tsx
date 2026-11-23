/**
 * What: shared tabs use the outlined primary selected treatment.
 * Why: list and detail navigation must match the desk toggle, not a muted pill
 * or an underline.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./tabs.js";

afterEach(cleanup);

function expectOutlinedPrimarySelected(tab: HTMLElement) {
  expect(tab.className).toContain("border-input");
  expect(tab.className).toContain("data-[state=active]:border-primary");
  expect(tab.className).toContain("data-[state=active]:bg-primary");
  expect(tab.className).toContain("data-[state=active]:text-primary-foreground");
  expect(tab.className).not.toContain("group-data-[variant=line]/tabs-list:after:bg-primary");
}

describe("tab visual hierarchy", () => {
  it("uses the outlined primary selected treatment", () => {
    render(
      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="vendors">Vendors</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const tabList = screen.getByRole("tablist");
    const activeTab = screen.getByRole("tab", {
      name: "All",
      selected: true,
    });

    expect(tabList.className).not.toContain("bg-muted");
    expect(tabList.className).toContain("group-data-[orientation=horizontal]/tabs:overflow-y-hidden");
    expect(activeTab.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(activeTab.className).toContain("[@media(pointer:coarse)]:min-w-11");
    expectOutlinedPrimarySelected(activeTab);
  });

  it("keeps line tabs on the same outlined primary treatment", () => {
    render(
      <Tabs defaultValue="details">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const tabList = screen.getByRole("tablist");
    const activeTab = screen.getByRole("tab", {
      name: "Details",
      selected: true,
    });

    expect(tabList.dataset["variant"]).toBe("line");
    expectOutlinedPrimarySelected(activeTab);
  });
});
