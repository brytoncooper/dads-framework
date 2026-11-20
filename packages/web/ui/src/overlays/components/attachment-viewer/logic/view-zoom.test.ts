/**
 * What: zoom steps for the PDF and image toolbars.
 * Why: the toolbar must always move to a sensible preset, even from the odd
 * scale that Fit Width or Fit to Window produces.
 */
import { describe, expect, it } from "vitest";

import { hasZoomStep, nextZoomScale } from "./view-zoom.js";

describe("nextZoomScale", () => {
  it("steps through the presets in both directions", () => {
    expect(nextZoomScale(1, "in")).toBe(1.25);
    expect(nextZoomScale(1, "out")).toBe(0.75);
    expect(nextZoomScale(0.25, "in")).toBe(0.5);
  });

  it("lands on the nearest preset on the requested side of an odd scale", () => {
    expect(nextZoomScale(1.37, "in")).toBe(1.5);
    expect(nextZoomScale(1.37, "out")).toBe(1.25);
  });

  it("treats floating-point noise as the preset itself", () => {
    expect(nextZoomScale(1.0000001, "in")).toBe(1.25);
    expect(nextZoomScale(0.9999999, "out")).toBe(0.75);
  });

  it("stops at the smallest and largest presets", () => {
    expect(nextZoomScale(4, "in")).toBe(4);
    expect(nextZoomScale(6, "in")).toBe(4);
    expect(nextZoomScale(0.25, "out")).toBe(0.25);
    expect(nextZoomScale(0.1, "out")).toBe(0.25);
  });
});

describe("hasZoomStep", () => {
  it("is false only at the ends", () => {
    expect(hasZoomStep(4, "in")).toBe(false);
    expect(hasZoomStep(3, "in")).toBe(true);
    expect(hasZoomStep(0.25, "out")).toBe(false);
    expect(hasZoomStep(0.5, "out")).toBe(true);
  });
});
