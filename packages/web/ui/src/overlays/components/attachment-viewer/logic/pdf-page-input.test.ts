/**
 * What: page clamping and page-box parsing for the PDF toolbar.
 * Why: the toolbar must never ask for a page that is not there, and a typo
 * must leave the reader where they were.
 */
import { describe, expect, it } from "vitest";

import { clampPageNumber, parsePageInput } from "./pdf-page-input.js";

describe("clampPageNumber", () => {
  it("keeps the page inside the document", () => {
    expect(clampPageNumber(0, 5)).toBe(1);
    expect(clampPageNumber(3, 5)).toBe(3);
    expect(clampPageNumber(9, 5)).toBe(5);
    expect(clampPageNumber(2.7, 5)).toBe(2);
  });

  it("falls back to page 1 when the document has no pages yet", () => {
    expect(clampPageNumber(4, 0)).toBe(1);
  });
});

describe("parsePageInput", () => {
  it("reads whole numbers and clamps them", () => {
    expect(parsePageInput(" 3 ", 5)).toBe(3);
    expect(parsePageInput("99", 5)).toBe(5);
    expect(parsePageInput("0", 5)).toBe(1);
  });

  it("rejects text that is not a whole number", () => {
    expect(parsePageInput("", 5)).toBeNull();
    expect(parsePageInput("abc", 5)).toBeNull();
    expect(parsePageInput("2.5", 5)).toBeNull();
    expect(parsePageInput("-1", 5)).toBeNull();
  });
});
