/**
 * createClock returns a clock whose now() is a Date.
 */
import { describe, expect, it } from "vitest";
import { createClock } from "./create-clock.js";

describe("createClock", () => {
  it("returns a ticking clock", () => {
    expect(createClock().now()).toBeInstanceOf(Date);
  });
});
