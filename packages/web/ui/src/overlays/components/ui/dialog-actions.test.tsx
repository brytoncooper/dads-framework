/**
 * What: editable dialogs expose one secondary Cancel action followed by the
 * primary action in an end-aligned footer.
 * Why: feature dialogs currently rebuild this relationship and some omit an
 * explicit way to cancel, so action order and treatment drift.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogAction,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./dialog.js";

afterEach(cleanup);

describe("standard dialog actions", () => {
  it("renders secondary then primary actions in the shared footer", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit Product</DialogTitle>
          <DialogDescription>Change the product name.</DialogDescription>
          <DialogFooter>
            <DialogCancel>Cancel</DialogCancel>
            <DialogAction>Save</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const footer = document.querySelector('[data-slot="dialog-footer"]');
    const actions = footer?.querySelectorAll("button");

    expect(footer?.className).toContain("sm:justify-end");
    expect(Array.from(actions ?? []).map((action) => action.textContent)).toEqual(["Cancel", "Save"]);
    expect(screen.getByRole("button", { name: "Cancel" }).dataset["variant"]).toBe("outline");
    expect(screen.getByRole("button", { name: "Save" }).dataset["variant"]).toBe("default");
  });

  it("closes through the dialog contract without submitting a form", () => {
    const onOpenChange = vi.fn();
    const attemptedSubmitProps = { type: "submit" as const };

    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Edit Product</DialogTitle>
          <DialogDescription>Change the product name.</DialogDescription>
          <form>
            <DialogFooter>
              <DialogCancel {...attemptedSubmitProps}>Cancel</DialogCancel>
              <DialogAction type="submit">Save</DialogAction>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.getAttribute("type")).toBe("button");

    fireEvent.click(cancel);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("places the optional Close action before the primary action", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit Product</DialogTitle>
          <DialogDescription>Change the product name.</DialogDescription>
          <DialogFooter showCloseButton>
            <DialogAction>Save</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(Array.from(footer?.querySelectorAll("button") ?? []).map((action) => action.textContent)).toEqual([
      "Close",
      "Save",
    ]);
  });
});
