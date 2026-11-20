export type ZoomDirection = "in" | "out";

/** The zoom levels Zoom In and Zoom Out step through, for PDFs and images alike. */
const ZOOM_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const FIRST_ZOOM_STEP = 0.25;
const LAST_ZOOM_STEP = 4;

/** Absorbs floating-point noise so 1.0000001 still counts as the 100% step. */
const SCALE_TOLERANCE = 0.001;

/**
 * The next preset zoom level in a direction. From a scale between presets
 * (for example the result of Fit Width) it lands on the nearest preset on the
 * requested side, and it stops at the smallest and largest preset.
 */
export function nextZoomScale(
  currentScale: number,
  direction: ZoomDirection,
): number {
  if (direction === "in") {
    const larger = ZOOM_STEPS.find(
      (step) => step > currentScale + SCALE_TOLERANCE,
    );
    return larger ?? LAST_ZOOM_STEP;
  }

  const smaller = [...ZOOM_STEPS]
    .reverse()
    .find((step) => step < currentScale - SCALE_TOLERANCE);
  return smaller ?? FIRST_ZOOM_STEP;
}

export function hasZoomStep(currentScale: number, direction: ZoomDirection) {
  return direction === "in"
    ? currentScale < LAST_ZOOM_STEP - SCALE_TOLERANCE
    : currentScale > FIRST_ZOOM_STEP + SCALE_TOLERANCE;
}
