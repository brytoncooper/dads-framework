/**
 * What: sheet actions reverse-stack on narrow screens and wrap end-aligned on
 * wider screens.
 * Why: drawer actions need a safe mobile order without losing desktop rhythm.
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SheetFooter } from "./sheet.js";

afterEach(cleanup);

describe("sheet action layout", () => {
  it("preserves footer spacing across responsive action layouts", () => {
    render(
      <SheetFooter>
        <button type="button">Cancel</button>
        <button type="button">Save</button>
      </SheetFooter>,
    );

    const footer = document.querySelector('[data-slot="sheet-footer"]');

    expect(footer?.className).toContain("mt-auto");
    expect(footer?.className).toContain("p-4");
    expect(footer?.className).toContain("flex-col-reverse");
    expect(footer?.className).toContain("sm:flex-row");
    expect(footer?.className).toContain("sm:flex-wrap");
    expect(footer?.className).toContain("sm:justify-end");
  });
});
