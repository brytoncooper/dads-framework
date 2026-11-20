/**
 * What: how large a photo is drawn when it is fitted to the window or turned.
 * Why: Fit to Window must show the whole photo, sideways photos included,
 * without blowing a small photo up past its own size.
 */
import { describe, expect, it } from "vitest";

import { fitImageScale, rotatedBox } from "./image-fit.js";

const landscape = { width: 4000, height: 3000 };
const stage = { width: 1000, height: 800 };

describe("fitImageScale", () => {
  it("shrinks a large photo until its longer side fits", () => {
    expect(fitImageScale(landscape, stage, 0)).toBeCloseTo(0.25, 10);
  });

  it("measures a turned photo with its sides swapped", () => {
    expect(fitImageScale(landscape, stage, 90)).toBeCloseTo(800 / 4000, 10);
  });

  it("never enlarges a photo smaller than the stage", () => {
    expect(fitImageScale({ width: 200, height: 100 }, stage, 0)).toBe(1);
  });

  it("shows an unmeasured photo or stage at actual size", () => {
    expect(fitImageScale({ width: 0, height: 0 }, stage, 0)).toBe(1);
    expect(fitImageScale(landscape, { width: 0, height: 0 }, 0)).toBe(1);
  });
});

describe("rotatedBox", () => {
  it("keeps the shape upright and upside down", () => {
    expect(rotatedBox(landscape, 0.5, 0)).toEqual({
      width: 2000,
      height: 1500,
    });
    expect(rotatedBox(landscape, 0.5, 180)).toEqual({
      width: 2000,
      height: 1500,
    });
  });

  it("swaps the sides when the photo is on its side", () => {
    expect(rotatedBox(landscape, 0.5, 270)).toEqual({
      width: 1500,
      height: 2000,
    });
  });
});
