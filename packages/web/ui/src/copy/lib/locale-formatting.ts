/**
 * Presentation formatting owned by the reader locale.
 *
 * Dates refuse an implicit time zone, currency refuses an implicit code, and
 * exact decimals never pass through JavaScript `number`. Human labels use the
 * reader's collation rules; stable product codes deliberately do not.
 */

export type ExplicitDateTimeFormatOptions = Omit<Intl.DateTimeFormatOptions, "timeZone"> & {
  readonly timeZone: string;
};

export type ExplicitCurrencyFormatOptions = Omit<Intl.NumberFormatOptions, "currency" | "style">;

export type ListFormatOptions = Intl.ListFormatOptions;

const CALENDAR_DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** Return the YYYY-MM-DD calendar date an instant belongs to in one named zone. */
export function formatCalendarDateKey(value: Date | number | string, timeZone: string): string {
  const parts = calendarDateFormatter(timeZone).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

/** Format an instant in the reader's locale and the caller's named time zone. */
export function formatDateTime(
  value: Date | number | string,
  locale: string,
  options: ExplicitDateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

/**
 * A time zone's everyday name in the reader's language, such as "Pacific
 * Time" for America/Los_Angeles. `null` when the zone is unknown here or has
 * no name beyond its UTC offset, so the caller can fall back to the zone id.
 */
export function formatTimeZoneName(timeZone: string, locale: string, at: Date | number | string): string | null {
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat(locale, {
      timeZone,
      timeZoneName: "longGeneric",
    })
      .formatToParts(new Date(at))
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return null;
  }
  if (name === undefined || name === timeZone) return null;
  return /^(?:GMT|UTC)(?:[+\-−]|$)/.test(name) ? null : name;
}

/** Format a presentation number without an implicit locale. */
export function formatNumber(value: number | bigint, locale: string, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** Format a count or other whole presentation number. */
export function formatInteger(value: number | bigint, locale: string): string {
  return formatNumber(value, locale, {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
}

/** Format money only when its domain-owned currency code is present. */
export function formatCurrency(
  value: number | bigint,
  locale: string,
  currency: string,
  options: ExplicitCurrencyFormatOptions = {},
): string {
  return formatNumber(value, locale, {
    ...options,
    style: "currency",
    currency,
  });
}

/** A distance from now in whole units, e.g. -2 minutes or 1 day. */
export type RelativeTimeFormatUnit = Intl.RelativeTimeFormatUnit;

/**
 * Word a distance from now in the reader's locale: "2 minutes ago", "in 12
 * minutes", "yesterday". The caller decides the unit and count.
 */
export function formatRelativeTime(value: number, unit: RelativeTimeFormatUnit, locale: string): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}

/**
 * Which ordinal form a position takes in the reader's locale — in English
 * "one" for 1st/21st, "two" for 2nd, "few" for 3rd, "other" for 4th. The
 * caller's catalog words each form.
 */
export function selectOrdinalCategory(value: number, locale: string): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale, { type: "ordinal" }).select(value);
}

/** Join human-authored items with the reader locale's grammar and punctuation. */
export function formatList(values: readonly string[], locale: string, options: ListFormatOptions = {}): string {
  return new Intl.ListFormat(locale, options).format([...values]);
}

const EXACT_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const ASCII_DIGITS = "0123456789";
const DIGIT_VALUES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Localize grouping, digits, and the decimal mark while preserving every
 * source digit and the source scale. Invalid input stays visible unchanged;
 * presentation formatting must not turn an integrity finding into zero.
 */
export function formatExactDecimal(value: string, locale: string): string {
  const match = EXACT_DECIMAL.exec(value);
  if (match === null) return value;

  const sign = match[1] ?? "";
  const whole = match[2];
  const fraction = match[3];
  if (whole === undefined) return value;

  const integerFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  const magnitude = BigInt(whole);
  const localizedWhole =
    sign === "-" ? integerFormatter.format(magnitude === 0n ? -0 : -magnitude) : integerFormatter.format(magnitude);

  if (fraction === undefined) return localizedWhole;

  return `${localizedWhole}${decimalSeparator(locale)}${localizeDigits(fraction, locale)}`;
}

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      useGrouping: false,
    })
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? "."
  );
}

function localizeDigits(value: string, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { useGrouping: false });
  const localizedDigits = DIGIT_VALUES.map((digit) => formatter.format(digit));
  let localized = "";

  for (const digit of value) {
    const index = ASCII_DIGITS.indexOf(digit);
    localized += localizedDigits[index] ?? digit;
  }

  return localized;
}

/** Compare human-authored labels with the reader's collation rules. */
export function compareHumanLabels(left: string, right: string, locale: string): number {
  return new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
    usage: "sort",
  }).compare(left, right);
}

/** Match human-authored text after locale-aware Unicode case folding. */
export function humanTextIncludes(value: string, query: string, locale: string): boolean {
  const foldedQuery = foldHumanText(query.trim(), locale);
  return foldedQuery === "" || foldHumanText(value, locale).includes(foldedQuery);
}

function foldHumanText(value: string, locale: string): string {
  return value.normalize("NFKC").toLocaleLowerCase(locale);
}

/** Stable codes sort identically for every reader and every machine. */
export function compareStableCodes(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The browser zone for surfaces explicitly defined in terms of the reader's
 * calendar day. Business-scoped timestamps should pass their domain time zone
 * instead; UTC is the explicit fallback where no business zone travels.
 */
export function resolveReaderTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function calendarDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = CALENDAR_DATE_FORMATTERS.get(timeZone);
  if (existing !== undefined) return existing;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  CALENDAR_DATE_FORMATTERS.set(timeZone, formatter);
  return formatter;
}
