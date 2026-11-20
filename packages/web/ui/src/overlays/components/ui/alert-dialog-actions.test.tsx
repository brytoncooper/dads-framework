/**
 * What: a destructive alert-dialog action has an explicit reusable primitive.
 * Why: the generic action is intentionally safe-primary by default, so archive
 * and remove confirmations otherwise look ordinary when a caller forgets a
 * variant prop.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog.js";

afterEach(cleanup);

describe("a destructive alert-dialog action", () => {
  it("always carries destructive button semantics", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Product?</AlertDialogTitle>
            <AlertDialogDescription>
              This product leaves the active catalog.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogDestructiveAction>Archive</AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(
      screen.getByRole("button", { name: "Archive" }).dataset["variant"],
    ).toBe("destructive");
  });
});
