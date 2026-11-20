import type { Locale } from "./localized-text.js";

/** The document flow direction a locale requires. */
export type TextDirection = "ltr" | "rtl";

export type LocaleMetadata = {
  readonly direction: TextDirection;
};

/** Runtime metadata for every supported reader locale. */
export const LOCALE_METADATA = {
  en: { direction: "ltr" },
} satisfies Readonly<Record<Locale, LocaleMetadata>>;

/** The document flow direction for one supported locale. */
export function textDirectionForLocale(locale: Locale): TextDirection {
  return LOCALE_METADATA[locale].direction;
}
