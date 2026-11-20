/**
 * What: default Dialog and Sheet X controls keep a 16px icon inside a 44px
 * coarse-pointer target.
 * Why: the visible X was also the full hit area, making the primary escape
 * control difficult to operate by touch even though its label and focus ring
 * were correct.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog.js";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet.js";

afterEach(cleanup);

function expectAccessibleCoarseTarget(closeButton: HTMLElement) {
  expect(closeButton.className).toContain("[@media(pointer:coarse)]:min-h-11");
  expect(closeButton.className).toContain("[@media(pointer:coarse)]:min-w-11");
  expect(closeButton.className).toContain("inline-flex");
  expect(closeButton.className).toContain("items-center");
  expect(closeButton.className).toContain("justify-center");
  expect(closeButton.className).toContain("transition-opacity");
  expect(closeButton.className).toContain("focus:ring-2");
}

describe("default overlay X close targets", () => {
  it("expands the Dialog target without enlarging its icon", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit Product</DialogTitle>
          <DialogDescription>Change the product.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const closeButton = screen.getByRole("button", { name: "Close" });
    expectAccessibleCoarseTarget(closeButton);
    expect(closeButton.querySelector("svg")).not.toBeNull();
    expect(closeButton.className).toContain(
      "[&_svg:not([class*='size-'])]:size-4",
    );
  });

  it("expands the Sheet target without enlarging its icon", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Create Product</SheetTitle>
          <SheetDescription>Configure the product.</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    const closeButton = screen.getByRole("button", { name: "Close" });
    expectAccessibleCoarseTarget(closeButton);
    expect(closeButton.querySelector("svg")?.getAttribute("class")).toContain(
      "size-4",
    );
  });
});
