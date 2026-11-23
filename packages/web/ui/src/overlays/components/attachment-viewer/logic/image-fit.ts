import { isSideways, type ViewRotation } from "./view-rotation.js";

export type BoxSize = {
  readonly width: number;
  readonly height: number;
};

/**
 * The scale that fits a photo inside the stage at a rotation. A turned photo
 * swaps its width and height before it is measured. A photo smaller than the
 * stage is never enlarged past its own size, and an unmeasured photo or stage
 * shows at actual size.
 */
export function fitImageScale(natural: BoxSize, stage: BoxSize, rotation: ViewRotation): number {
  const turned = rotatedBox(natural, 1, rotation);
  if (turned.width <= 0 || turned.height <= 0) return 1;
  if (stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(1, stage.width / turned.width, stage.height / turned.height);
}

/** The box a photo takes up on screen at a scale and rotation. */
export function rotatedBox(natural: BoxSize, scale: number, rotation: ViewRotation): BoxSize {
  const width = natural.width * scale;
  const height = natural.height * scale;
  return isSideways(rotation) ? { width: height, height: width } : { width, height };
}
