/**
 * What: the size each page thumbnail is laid out and drawn at, and when the
 * rail starts open.
 * Why: thumbnails must keep their page's shape, stay crisp without wasting
 * pixels, and leave a phone-width screen to the page itself.
 */
import { describe, expect, it } from "vitest";

import {
  RAIL_DEFAULT_OPEN_MIN_WIDTH,
  THUMBNAIL_DEVICE_PIXEL_CAP,
  THUMBNAIL_MAX_WIDTH,
  railDefaultOpen,
  thumbnailDimensions,
} from "./pdf-thumbnail.js";

describe("thumbnailDimensions", () => {
  it("scales a page so its CSS width lands on the rail width and keeps its shape", () => {
    const dims = thumbnailDimensions(612, 792, { devicePixelRatio: 1 });
    expect(dims.cssWidth).toBe(THUMBNAIL_MAX_WIDTH);
    expect(dims.cssHeight).toBe(Math.round(792 * (THUMBNAIL_MAX_WIDTH / 612)));
    expect(dims.canvasWidth).toBe(THUMBNAIL_MAX_WIDTH);
    expect(dims.canvasHeight).toBe(dims.cssHeight);
  });

  it("draws the bitmap at the device ratio so a high-density thumbnail stays crisp", () => {
    const dims = thumbnailDimensions(612, 792, { devicePixelRatio: 2 });
    expect(dims.devicePixelRatio).toBe(2);
    expect(dims.canvasWidth).toBe(dims.cssWidth * 2);
    expect(dims.canvasHeight).toBe(dims.cssHeight * 2);
  });

  it("caps the device ratio so a 3x screen does not draw wasted pixels", () => {
    const dims = thumbnailDimensions(612, 792, { devicePixelRatio: 3 });
    expect(dims.devicePixelRatio).toBe(THUMBNAIL_DEVICE_PIXEL_CAP);
  });

  it("never drops below one device pixel per CSS pixel", () => {
    const dims = thumbnailDimensions(612, 792, { devicePixelRatio: 0.5 });
    expect(dims.devicePixelRatio).toBe(1);
  });

  it("falls back to the rail width rather than dividing by a zero-sized page", () => {
    const dims = thumbnailDimensions(0, 0);
    expect(dims.canvasWidth).toBeGreaterThanOrEqual(1);
    expect(dims.canvasHeight).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(dims.scale)).toBe(true);
  });

  it("honours an explicit rail width", () => {
    const dims = thumbnailDimensions(100, 200, {
      maxWidth: 50,
      devicePixelRatio: 1,
    });
    expect(dims.cssWidth).toBe(50);
    expect(dims.cssHeight).toBe(100);
  });
});

describe("railDefaultOpen", () => {
  it("opens in a wide window and stays shut in a narrow one", () => {
    expect(railDefaultOpen(RAIL_DEFAULT_OPEN_MIN_WIDTH)).toBe(true);
    expect(railDefaultOpen(RAIL_DEFAULT_OPEN_MIN_WIDTH + 400)).toBe(true);
    expect(railDefaultOpen(RAIL_DEFAULT_OPEN_MIN_WIDTH - 1)).toBe(false);
  });

  it("respects a caller-supplied breakpoint", () => {
    expect(railDefaultOpen(500, 400)).toBe(true);
    expect(railDefaultOpen(300, 400)).toBe(false);
  });
});
