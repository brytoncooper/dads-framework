/**
 * The geometry the thumbnail rail draws each page at.
 *
 * A thumbnail is a page drawn small: laid out at a fixed CSS width so the rail
 * is a predictable size, and drawn at up to twice that in device pixels so it
 * stays crisp on a high-density screen without paying for a 3x phone ratio on
 * an image this small.
 */

/** The CSS width, in px, a thumbnail is laid out to. */
export const THUMBNAIL_MAX_WIDTH = 112;

/** The most device pixels drawn per CSS pixel. */
export const THUMBNAIL_DEVICE_PIXEL_CAP = 2;

/** Below this window width the rail starts closed, so a phone keeps the page. */
export const RAIL_DEFAULT_OPEN_MIN_WIDTH = 768;

export type ThumbnailDimensions = {
  /** The scale handed to `getViewport` so the page's width lands on the CSS width. */
  readonly scale: number;
  /** The laid-out size of the canvas element, in CSS px. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** The bitmap size of the canvas, in device px. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** The multiplier the bitmap is drawn at. */
  readonly devicePixelRatio: number;
};

export type ThumbnailDimensionOptions = {
  readonly maxWidth?: number;
  readonly devicePixelCap?: number;
  readonly devicePixelRatio?: number;
};

/**
 * How big a thumbnail's canvas should be. `pageWidth` and `pageHeight` are the
 * page's size at scale 1. The result carries the CSS size the element is laid
 * out to and the larger bitmap size it is drawn at.
 */
export function thumbnailDimensions(
  pageWidth: number,
  pageHeight: number,
  options: ThumbnailDimensionOptions = {},
): ThumbnailDimensions {
  const maxWidth = options.maxWidth ?? THUMBNAIL_MAX_WIDTH;
  const cap = options.devicePixelCap ?? THUMBNAIL_DEVICE_PIXEL_CAP;
  const rawRatio = options.devicePixelRatio ?? 1;

  const safeWidth = pageWidth > 0 ? pageWidth : maxWidth;
  const safeHeight = pageHeight > 0 ? pageHeight : maxWidth;

  const scale = maxWidth / safeWidth;
  const cssWidth = Math.round(safeWidth * scale);
  const cssHeight = Math.round(safeHeight * scale);

  const devicePixelRatio = Math.max(1, Math.min(rawRatio, cap));
  const canvasWidth = Math.max(1, Math.floor(cssWidth * devicePixelRatio));
  const canvasHeight = Math.max(1, Math.floor(cssHeight * devicePixelRatio));

  return {
    scale,
    cssWidth,
    cssHeight,
    canvasWidth,
    canvasHeight,
    devicePixelRatio,
  };
}

/** Whether the rail should start open in a window this wide. */
export function railDefaultOpen(
  windowWidth: number,
  minWidth: number = RAIL_DEFAULT_OPEN_MIN_WIDTH,
): boolean {
  return windowWidth >= minWidth;
}
