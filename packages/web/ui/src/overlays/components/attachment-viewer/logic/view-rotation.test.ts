/**
 * What: quarter-turn arithmetic for Rotate Clockwise and Rotate Counterclockwise.
 * Why: a scanned page that arrives sideways must turn upright and back again,
 * whatever angle pdf.js reports.
 */
import { describe, expect, it } from "vitest";

import {
  INITIAL_ROTATION,
  isSideways,
  nextRotation,
  normalizeRotation,
  type RotateDirection,
  type ViewRotation,
} from "./view-rotation.js";

const DIRECTIONS: readonly RotateDirection[] = ["clockwise", "counterclockwise"];

describe("nextRotation", () => {
  it("turns a quarter at a time in each direction", () => {
    expect(nextRotation(0, "clockwise")).toBe(90);
    expect(nextRotation(90, "clockwise")).toBe(180);
    expect(nextRotation(180, "clockwise")).toBe(270);
    expect(nextRotation(0, "counterclockwise")).toBe(270);
    expect(nextRotation(270, "counterclockwise")).toBe(180);
    expect(nextRotation(90, "counterclockwise")).toBe(0);
  });

  it("wraps back to the start at the top of a full turn", () => {
    expect(nextRotation(270, "clockwise")).toBe(0);
    expect(nextRotation(0, "counterclockwise")).toBe(270);
  });

  it("returns to the original orientation after four presses either way", () => {
    for (const direction of DIRECTIONS) {
      let rotation: ViewRotation = INITIAL_ROTATION;
      for (let press = 0; press < 4; press += 1) {
        rotation = nextRotation(rotation, direction);
      }
      expect(rotation).toBe(INITIAL_ROTATION);
    }
  });

  it("cancels a clockwise press with a counterclockwise one", () => {
    expect(nextRotation(nextRotation(180, "clockwise"), "counterclockwise")).toBe(180);
  });

  it("accepts out-of-range input and lands on a valid rotation", () => {
    expect(nextRotation(360, "clockwise")).toBe(90);
    expect(nextRotation(-90, "clockwise")).toBe(0);
    expect(nextRotation(450, "counterclockwise")).toBe(0);
  });
});

describe("normalizeRotation", () => {
  it("leaves valid rotations alone", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
  });

  it("wraps angles past a full turn and below zero", () => {
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(540)).toBe(180);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-360)).toBe(0);
  });
});

describe("isSideways", () => {
  it("is true only for quarter and three-quarter turns", () => {
    expect(isSideways(0)).toBe(false);
    expect(isSideways(90)).toBe(true);
    expect(isSideways(180)).toBe(false);
    expect(isSideways(270)).toBe(true);
  });
});
