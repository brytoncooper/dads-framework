/**
 * What: a Dialog stays open on overlay and outside clicks; only Close or
 * Cancel dismisses it.
 * Why: a modal dialog made the portaled picker inert, and backdrop clicks
 * dismissed the form mid-choice.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./dialog.js";

afterEach(cleanup);

function renderOpenDialog(onOpenChange = vi.fn()) {
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Add Facility</DialogTitle>
        <DialogDescription>Choose a facility.</DialogDescription>
        <DialogFooter>
          <DialogCancel>Cancel</DialogCancel>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
  return onOpenChange;
}

describe("dialog dismiss", () => {
  it("does not mark the dialog modal so a portaled picker stays usable", () => {
    renderOpenDialog();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).not.toBe(
      "true",
    );
  });

  it("does not close when the overlay is clicked", () => {
    const onOpenChange = renderOpenDialog();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    if (overlay === null) {
      throw new Error("dialog overlay missing");
    }
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("does not close on Escape", () => {
    const onOpenChange = renderOpenDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes from the X control", () => {
    const onOpenChange = renderOpenDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes from Cancel", () => {
    const onOpenChange = renderOpenDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
