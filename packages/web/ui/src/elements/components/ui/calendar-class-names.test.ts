/**
 * What: the month grid is seven flex columns; day cells are not bordered cards.
 * Why: missing week/weekday flex plus a border on every day made the picker
 * look like overlapping bubbles instead of a calendar.
 */
import { describe, expect, it } from "vitest";

import { calendarClassNames } from "./calendar.js";

describe("calendarClassNames", () => {
  it("lays weekday labels and date rows out as matching flex rows", () => {
    expect(calendarClassNames.weekdays).toMatch(/\bflex\b/);
    expect(calendarClassNames.week).toMatch(/\bflex\b/);
    expect(calendarClassNames.weekday).toMatch(/\bflex-1\b/);
  });

  it("keeps day cells borderless until they are selected", () => {
    expect(calendarClassNames.day_button).not.toMatch(/border-input/);
  });
});
