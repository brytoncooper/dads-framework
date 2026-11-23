/**
 * What: the location trail has three roles — link, locked parent, current page —
 * and stays on one line with a quiet separator.
 * Why: sharing one disabled-link primitive for “here” and “you may not enter”
 * makes both states unreadable, and a wrapping chevron trail blows the header.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Breadcrumb,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbLocked,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./breadcrumb.js";

afterEach(cleanup);

describe("breadcrumb visual hierarchy", () => {
  it("uses link color for ancestors and foreground for the current page", () => {
    render(
      <Breadcrumb>
        <BreadcrumbLink href="/products">Products</BreadcrumbLink>
        <BreadcrumbPage>Premium Mix</BreadcrumbPage>
      </Breadcrumb>,
    );

    const ancestor = screen.getByRole("link", { name: "Products" });
    const currentPage = screen.getByText("Premium Mix");

    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeDefined();
    expect(currentPage.getAttribute("aria-current")).toBe("page");
    expect(currentPage.getAttribute("role")).toBeNull();
    expect(ancestor.className).toContain("text-link");
    expect(ancestor.className).toContain("font-medium");
    expect(ancestor.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(ancestor.className).toContain("[@media(pointer:coarse)]:min-w-11");
    expect(ancestor.className).toContain("focus-visible:ring-[3px]");
    expect(ancestor.className).not.toContain("hover:text-foreground");
    expect(currentPage.className).toContain("text-foreground");
    expect(currentPage.className).toContain("font-medium");
    expect(currentPage.className).not.toContain("text-link");
  });

  it("keeps a locked parent muted and not current", () => {
    render(
      <Breadcrumb>
        <BreadcrumbLocked>Acme Foods</BreadcrumbLocked>
        <BreadcrumbPage>North Mill</BreadcrumbPage>
      </Breadcrumb>,
    );

    const locked = screen.getByText("Acme Foods");
    expect(locked.getAttribute("aria-current")).toBeNull();
    expect(locked.getAttribute("role")).toBeNull();
    expect(locked.className).toContain("text-muted-foreground");
    expect(locked.className).toContain("font-medium");
    expect(screen.queryByRole("link", { name: "Acme Foods" })).toBeNull();
  });

  it("uses a muted slash and stays on one line", () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbSeparator />
        </BreadcrumbList>
      </Breadcrumb>,
    );

    const list = screen.getByRole("list");
    expect(list.className).toContain("flex-nowrap");
    expect(list.className).toContain("overflow-hidden");
    expect(screen.getByText("/")).toBeDefined();
    expect(list.querySelector("svg")).toBeNull();
  });
});
