/**
 * What: action buttons have visible outlines while link badges retain link styling.
 * Why: actions must be recognizable before hover without changing navigation links.
 */
import { describe, expect, it } from "vitest";
import { badgeVariants } from "./badge.js";
import { buttonVariants } from "./button.js";

describe("action and link variants", () => {
  it("gives secondary primary-color actions a visible outline", () => {
    const classes = buttonVariants({ variant: "outlinePrimary" });

    expect(classes.split(" ")).toContain("border");
    expect(classes).toContain("border-primary");
    expect(classes).toContain("text-primary");
  });

  it("uses the link token for badges", () => {
    const classes = badgeVariants({ variant: "link" });

    expect(classes).toContain("text-link");
    expect(classes).not.toContain("text-primary");
    expect(classes).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(classes).toContain("[@media(pointer:coarse)]:min-w-11");
  });
});
