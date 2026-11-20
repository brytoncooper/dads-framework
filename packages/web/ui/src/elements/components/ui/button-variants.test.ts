/**
 * What: outline buttons sit on the card token, not the page.
 * Why: `--background` is dead concrete; a control must stay white so it reads
 * as a button instead of a hole in the page.
 */
import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button.js";

describe("outline button fill", () => {
  it("uses the card surface instead of the page background", () => {
    const classes = buttonVariants({ variant: "outline" });

    expect(classes).toContain("bg-card");
    expect(classes).not.toContain("bg-background");
  });
});
