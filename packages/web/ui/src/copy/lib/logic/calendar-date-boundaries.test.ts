/** Shared business-day boundaries keep facility and order calendars independent of the browser timezone. */
import { describe, expect, it } from "vitest";

import { endOfCalendarDate, startOfCalendarDate } from "./calendar-date-boundaries.js";

describe("calendar date boundaries", () => {
  it("includes a full facility day that crosses a UTC date", () => {
    expect(startOfCalendarDate("2026-09-03", "America/Los_Angeles")).toBe("2026-09-03T07:00:00.000Z");
    expect(endOfCalendarDate("2026-09-03", "America/Los_Angeles")).toBe("2026-09-04T06:59:59.999Z");
  });

  it("uses the next calendar boundary on both DST transition days", () => {
    expect(startOfCalendarDate("2026-03-08", "America/Boise")).toBe("2026-03-08T07:00:00.000Z");
    expect(endOfCalendarDate("2026-03-08", "America/Boise")).toBe("2026-03-09T05:59:59.999Z");
    expect(startOfCalendarDate("2026-11-01", "America/Boise")).toBe("2026-11-01T06:00:00.000Z");
    expect(endOfCalendarDate("2026-11-01", "America/Boise")).toBe("2026-11-02T06:59:59.999Z");
  });

  it("rejects impossible and skipped calendar dates", () => {
    expect(startOfCalendarDate("2026-02-30", "UTC")).toBeNull();
    expect(endOfCalendarDate("2026-02-30", "UTC")).toBeNull();
    expect(startOfCalendarDate("2011-12-30", "Pacific/Apia")).toBeNull();
    expect(endOfCalendarDate("2011-12-30", "Pacific/Apia")).toBeNull();
  });
});
