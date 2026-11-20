/**
 * The quarter turn a PDF or image is shown at, and the step one rotate press
 * takes. Rotation is view-only: the stored file is never changed.
 */

export type ViewRotation = 0 | 90 | 180 | 270;

export type RotateDirection = "clockwise" | "counterclockwise";

export const INITIAL_ROTATION: ViewRotation = 0;

const ROTATION_STEP = 90;

/** The rotation one press lands on, wrapping at both ends. */
export function nextRotation(
  current: number,
  direction: RotateDirection,
): ViewRotation {
  const delta = direction === "clockwise" ? ROTATION_STEP : -ROTATION_STEP;
  return normalizeRotation(current + delta);
}

/** The nearest quarter turn at or below the angle, held in 0..270. */
export function normalizeRotation(angle: number): ViewRotation {
  const quarterTurns = Math.floor(angle / ROTATION_STEP);
  const wrapped = ((quarterTurns % 4) + 4) % 4;
  switch (wrapped) {
    case 1:
      return 90;
    case 2:
      return 180;
    case 3:
      return 270;
    default:
      return 0;
  }
}

/** True when the rotation lays the picture on its side, swapping width and height. */
export function isSideways(rotation: ViewRotation): boolean {
  return rotation === 90 || rotation === 270;
}
