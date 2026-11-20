export {
  SUPPORTED_LOCALES,
  defineCopy,
  isSupportedLocale,
  resolveLocalizedText,
  type CopyCatalog,
  type Locale,
  type LocalizedText,
} from "./lib/localized-text.js";
export {
  mergeCopy,
  type CopySource,
  type MergedCopy,
  type MergedCopyEntry,
} from "./lib/merge-copy.js";
export {
  defineGlossary,
  glossaryCatalog,
  type Glossary,
  type GlossaryEntry,
} from "./lib/glossary.js";
export {
  copy,
  isCopyDescriptor,
  type CopyDescriptor,
  type CopyVars,
} from "./lib/copy-descriptor.js";
export {
  translate,
  type CopyKey,
  type PluralBaseKey,
  type PluralCategory,
} from "./lib/translate.js";
export { createCopyHook, type CopyTranslator } from "./lib/create-copy-hook.js";
export {
  LocaleProvider,
  useLocale,
  useLocaleSelection,
  type LocaleProviderProps,
  type LocaleSelection,
} from "./lib/locale-provider.js";
export {
  DEFAULT_LOCALE,
  matchSupportedLocale,
  resolveInitialLocale,
  resolveLocaleFromSignals,
  type LocaleSignals,
} from "./lib/resolve-initial-locale.js";
export {
  LOCALE_METADATA,
  textDirectionForLocale,
  type LocaleMetadata,
  type TextDirection,
} from "./lib/locale-metadata.js";
export {
  compareHumanLabels,
  compareStableCodes,
  formatCalendarDateKey,
  formatCurrency,
  formatDateTime,
  formatExactDecimal,
  formatInteger,
  formatList,
  formatNumber,
  formatRelativeTime,
  formatTimeZoneName,
  humanTextIncludes,
  resolveReaderTimeZone,
  selectOrdinalCategory,
  type ExplicitCurrencyFormatOptions,
  type ExplicitDateTimeFormatOptions,
  type ListFormatOptions,
  type RelativeTimeFormatUnit,
} from "./lib/locale-formatting.js";
export {
  startOfCalendarDate,
  endOfCalendarDate,
} from "./lib/logic/calendar-date-boundaries.js";
export {
  useLocaleFormatting,
  type LocaleFormatting,
} from "./lib/use-locale-formatting.js";
export {
  FormattedDateTime,
  FormattedExactDecimal,
  FormattedInteger,
  type FormattedDateTimeProps,
} from "./lib/formatted-values.js";
export {
  assertCatalogParity,
  checkCatalogParity,
  placeholdersOf,
  type CatalogParityReport,
  type MalformedPlaceholder,
  type MissingTranslation,
  type PlaceholderMismatch,
  type PluralFallbackGap,
} from "./lib/catalog-parity.js";
export {
  checkEnglishChromeCase,
  type EnglishChromeCaseViolation,
} from "./lib/english-chrome-case.js";
export {
  checkProductVocabulary,
  defineProductVocabulary,
  type ProductVocabulary,
  type ProductVocabularyViolation,
  type RefusedWord,
} from "./lib/product-vocabulary.js";
