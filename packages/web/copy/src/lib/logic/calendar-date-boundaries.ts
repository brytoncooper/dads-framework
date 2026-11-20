import { formatCalendarDateKey } from "../locale-formatting.js";

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEARCH_MARGIN_MS = 36 * 60 * 60 * 1000;

type CalendarDateParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

/** First UTC instant of an exact YYYY-MM-DD date in a named business timezone. */
export function startOfCalendarDate(
  value: string,
  timeZone: string,
): string | null {
  const parts = parseCalendarDate(value);
  if (parts === null) return null;
  const firstInstant = firstInstantOfDate(parts, timeZone);
  return firstInstant === null ? null : new Date(firstInstant).toISOString();
}

/** Inclusive final UTC millisecond of a business date, preserving short and long DST days. */
export function endOfCalendarDate(
  value: string,
  timeZone: string,
): string | null {
  const parts = parseCalendarDate(value);
  if (parts === null) return null;
  const firstInstant = firstInstantOfDate(parts, timeZone);
  const nextInstant = firstInstantOfDate(nextCalendarDate(parts), timeZone);
  if (firstInstant === null || nextInstant === null) return null;
  return new Date(nextInstant - 1).toISOString();
}

function firstInstantOfDate(
  parts: CalendarDateParts,
  timeZone: string,
): number | null {
  const target = dateKey(parts);
  const approximateUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  let lower = approximateUtc - SEARCH_MARGIN_MS;
  let upper = approximateUtc + SEARCH_MARGIN_MS;

  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (formatCalendarDateKey(middle, timeZone) < target) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }

  return formatCalendarDateKey(lower, timeZone) === target ? lower : null;
}

function parseCalendarDate(value: string): CalendarDateParts | null {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  if (year === undefined || month === undefined || day === undefined)
    return null;
  const parts = { year: Number(year), month: Number(month), day: Number(day) };
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() + 1 === parts.month &&
    date.getUTCDate() === parts.day
    ? parts
    : null;
}

function nextCalendarDate(parts: CalendarDateParts): CalendarDateParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function dateKey(parts: CalendarDateParts): string {
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}
