/**
 * What: locale formatting keeps reader language, time zone, exact decimals,
 * currency, human text, and stable codes on their deliberately different paths.
 * Why: a selected app locale is not real while presentation still falls back
 * to the browser locale or turns exact decimal strings into floating point.
 */
import { describe, expect, it } from "vitest";
import {
  compareHumanLabels,
  compareStableCodes,
  formatCalendarDateKey,
  formatCurrency,
  formatDateTime,
  formatExactDecimal,
  formatInteger,
  formatList,
  formatRelativeTime,
  formatTimeZoneName,
  humanTextIncludes,
  selectOrdinalCategory,
} from "./locale-formatting.js";

describe("locale formatting", () => {
  it("returns the calendar date an instant belongs to in a named business timezone", () => {
    expect(formatCalendarDateKey("2026-08-28T05:59:59.999Z", "America/Boise")).toBe("2026-08-27");
  });

  it("formats one instant in the explicitly chosen time zone", () => {
    const instant = "2026-08-20T18:30:00.000Z";

    const utc = formatDateTime(instant, "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    });
    const denver = formatDateTime(instant, "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Denver",
    });

    expect(utc).not.toBe(denver);
  });

  it("groups an integer with the reader locale", () => {
    expect(formatInteger(1_234_567, "de-DE")).toBe("1.234.567");
  });

  it("localizes an exact decimal without passing it through Number", () => {
    expect(formatExactDecimal("9007199254740993.5000", "de-DE")).toBe("9.007.199.254.740.993,5000");
  });

  it("requires the currency code at the formatting call", () => {
    expect(formatCurrency(1234.5, "en-US", "USD")).toBe("$1,234.50");
    expect(formatCurrency(1234.5, "en-US", "EUR")).toBe("€1,234.50");
  });

  it("joins human lists with the reader locale's grammar", () => {
    const items = ["Alpha", "Beta", "Gamma"];

    expect(formatList(items, "en-US")).toBe("Alpha, Beta, and Gamma");
    expect(formatList(items, "es-ES")).toBe("Alpha, Beta y Gamma");
  });

  it("words a distance from now in the reader locale", () => {
    expect(formatRelativeTime(-2, "minute", "en-US")).toBe("2 minutes ago");
    expect(formatRelativeTime(12, "minute", "en-US")).toBe("in 12 minutes");
    expect(formatRelativeTime(-1, "day", "en-US")).toBe("yesterday");
    expect(formatRelativeTime(-2, "minute", "es-ES")).toBe("hace 2 minutos");
  });

  it("names a time zone in the reader locale", () => {
    const at = "2026-10-28T12:00:00.000Z";

    expect(formatTimeZoneName("America/Los_Angeles", "en-US", at)).toBe("Pacific Time");
    expect(formatTimeZoneName("America/Boise", "en-US", at)).toBe("Mountain Time");
    expect(formatTimeZoneName("America/Boise", "es-ES", at)).not.toBe("Mountain Time");
  });

  it("gives no name for a zone known only by its offset, or not known at all", () => {
    const at = "2026-10-28T12:00:00.000Z";

    expect(formatTimeZoneName("UTC", "en-US", at)).toBeNull();
    expect(formatTimeZoneName("Not/AZone", "en-US", at)).toBeNull();
  });

  it("selects the reader locale's ordinal form for a position", () => {
    expect([1, 2, 3, 4, 11, 21, 22, 23].map((n) => selectOrdinalCategory(n, "en-US"))).toEqual([
      "one",
      "two",
      "few",
      "other",
      "other",
      "one",
      "two",
      "few",
    ]);
    expect(selectOrdinalCategory(2, "es-ES")).toBe("other");
  });
});

describe("human text and stable codes", () => {
  it("sorts human labels with the reader locale", () => {
    const labels = ["Äpple", "Zebra"];

    expect([...labels].sort((left, right) => compareHumanLabels(left, right, "sv-SE"))).toEqual(["Zebra", "Äpple"]);
  });

  it("folds human search text with the reader locale", () => {
    expect(humanTextIncludes("İrmik", "irmik", "tr-TR")).toBe(true);
  });

  it("orders stable codes by code point instead of reader collation", () => {
    expect(["Z-2", "A-10"].sort(compareStableCodes)).toEqual(["A-10", "Z-2"]);
  });
});
