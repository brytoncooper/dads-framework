import { useMemo } from "react";

import {
  compareHumanLabels,
  type ExplicitCurrencyFormatOptions,
  type ExplicitDateTimeFormatOptions,
  formatCurrency,
  formatDateTime,
  formatExactDecimal,
  formatInteger,
  formatList,
  formatNumber,
  formatRelativeTime,
  formatTimeZoneName,
  humanTextIncludes,
  type ListFormatOptions,
  type RelativeTimeFormatUnit,
  selectOrdinalCategory,
} from "./locale-formatting.js";
import { useLocale } from "./locale-provider.js";

/** Locale-bound presentation functions for a React render tree. */
export type LocaleFormatting = {
  readonly formatDateTime: (value: Date | number | string, options: ExplicitDateTimeFormatOptions) => string;
  readonly formatNumber: (value: number | bigint, options?: Intl.NumberFormatOptions) => string;
  readonly formatInteger: (value: number | bigint) => string;
  readonly formatExactDecimal: (value: string) => string;
  readonly formatCurrency: (
    value: number | bigint,
    currency: string,
    options?: ExplicitCurrencyFormatOptions,
  ) => string;
  readonly formatList: (values: readonly string[], options?: ListFormatOptions) => string;
  readonly formatRelativeTime: (value: number, unit: RelativeTimeFormatUnit) => string;
  readonly formatTimeZoneName: (timeZone: string, at: Date | number | string) => string | null;
  readonly selectOrdinalCategory: (value: number) => Intl.LDMLPluralRule;
  readonly compareHumanLabels: (left: string, right: string) => number;
  readonly humanTextIncludes: (value: string, query: string) => boolean;
};

/** Bind every formatter to the same reader locale as the copy hooks. */
export function useLocaleFormatting(): LocaleFormatting {
  const locale = useLocale();

  return useMemo(
    () => ({
      formatDateTime: (value, options) => formatDateTime(value, locale, options),
      formatNumber: (value, options) => formatNumber(value, locale, options),
      formatInteger: (value) => formatInteger(value, locale),
      formatExactDecimal: (value) => formatExactDecimal(value, locale),
      formatCurrency: (value, currency, options) => formatCurrency(value, locale, currency, options),
      formatList: (values, options) => formatList(values, locale, options),
      formatRelativeTime: (value, unit) => formatRelativeTime(value, unit, locale),
      formatTimeZoneName: (timeZone, at) => formatTimeZoneName(timeZone, locale, at),
      selectOrdinalCategory: (value) => selectOrdinalCategory(value, locale),
      compareHumanLabels: (left, right) => compareHumanLabels(left, right, locale),
      humanTextIncludes: (value, query) => humanTextIncludes(value, query, locale),
    }),
    [locale],
  );
}
