/**
 * Filter values travel through the URL as text, so a picked date becomes the
 * epoch milliseconds it stands for; nothing picked becomes the empty string.
 */
export function toTimestampText(date: Date | undefined): string {
  return date ? date.getTime().toString() : "";
}

/**
 * A column's filter value as text for a controlled input.
 *
 * TanStack types `getFilterValue()` as `unknown` because a filter value is
 * whatever the column put there, so anything that is not already text (an
 * unset filter, a faceted array, a range tuple) reads as the empty string.
 */
export function toFilterText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  return "";
}

/** Two dates that land on the same calendar day. Absent dates never match. */
export function isSameDay(
  left: Date | undefined,
  right: Date | undefined,
): boolean {
  if (!left || !right) return false;
  return left.toDateString() === right.toDateString();
}

export function formatDate(
  date: Date | string | number | undefined,
  formatting: LocaleFormatting,
  opts: ExplicitDateTimeFormatOptions,
) {
  if (!date) return "";

  try {
    return formatting.formatDateTime(date, {
      month: opts.month ?? "long",
      day: opts.day ?? "numeric",
      year: opts.year ?? "numeric",
      ...opts,
    });
  } catch {
    return "";
  }
}
import type {
  ExplicitDateTimeFormatOptions,
  LocaleFormatting,
} from "../../copy/index.js";
