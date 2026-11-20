/**
 * What: a page's sections as tabs — down the side, or a strip on a phone.
 * Why: the current section must be announced and marked, and the rest must
 * still read as things to press; a section list that fades its options or
 * hides which one is open is the failure this component exists to end.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SectionNav, SectionNavCount, SectionNavItem } from "./section-nav.js";

afterEach(cleanup);

describe("section-nav", () => {
  it("names the navigation and announces only the current section", () => {
    render(
      <SectionNav label="Areas">
        <SectionNavItem current={false}>Email</SectionNavItem>
        <SectionNavItem current>Identity</SectionNavItem>
      </SectionNav>,
    );

    expect(screen.getByRole("navigation", { name: "Areas" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Identity" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Email" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks the current section with a bar, a tint, and weight", () => {
    render(
      <SectionNav label="Areas">
        <SectionNavItem current={false}>Email</SectionNavItem>
        <SectionNavItem current>Identity</SectionNavItem>
      </SectionNav>,
    );

    const current = screen.getByRole("button", { name: "Identity" }).className;
    expect(current).toContain("border-primary");
    expect(current).toContain("md:bg-primary/10");
    expect(current).toContain("font-semibold");

    const other = screen.getByRole("button", { name: "Email" }).className;
    expect(other).not.toContain("border-primary");
    expect(other).toContain("text-foreground");
    expect(other).not.toContain("text-foreground/");
  });

  it("keeps every section a touch target on a phone", () => {
    render(
      <SectionNav label="Areas">
        <SectionNavItem current={false}>Email</SectionNavItem>
      </SectionNav>,
    );

    expect(screen.getByRole("button", { name: "Email" }).className).toContain(
      "min-h-11",
    );
  });

  it("styles a feature-owned link and announces it as the current page", () => {
    render(
      <SectionNav label="Equipment">
        <SectionNavItem asChild current>
          <a href="/equipment/scales">
            Scales <SectionNavCount>3</SectionNavCount>
          </a>
        </SectionNavItem>
      </SectionNav>,
    );

    const link = screen.getByRole("link", { name: "Scales 3" });
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.getAttribute("href")).toBe("/equipment/scales");
    expect(link.className).toContain("border-primary");
  });
});
