import { type LocalizedText, SUPPORTED_LOCALES } from "./localized-text.js";
import type { MergedCopy } from "./merge-copy.js";
import { inspectPlaceholderSyntax } from "./placeholder-syntax.js";

/**
 * The worklist a second language starts from.
 *
 * With one locale this is trivially true, which is exactly why it lands now:
 * the day `SUPPORTED_LOCALES` grows a second entry, this check names every key
 * that still needs a phrase — key AND file — instead of leaving a translator to
 * read a diff. The placeholder half catches the subtler failure, where a
 * translated sentence quietly drops `{count}` and the number never renders.
 */

/** A key that has no phrase in one of the locales this product speaks. */
export type MissingTranslation = {
  readonly key: string;
  readonly file: string;
  readonly locale: string;
};

/** A translated phrase whose `{placeholders}` disagree with the reference. */
export type PlaceholderMismatch = {
  readonly key: string;
  readonly file: string;
  readonly locale: string;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
};

/** A phrase containing brace text that is not a valid `{placeholderName}`. */
export type MalformedPlaceholder = {
  readonly key: string;
  readonly file: string;
  readonly locale: string;
  readonly token: string;
};

/** A plural key family that cannot safely fall back for every locale. */
export type PluralFallbackGap = {
  readonly key: string;
  readonly file: string;
  readonly missingKey: string;
};

export type CatalogParityReport = {
  readonly missingTranslations: readonly MissingTranslation[];
  readonly malformedPlaceholders: readonly MalformedPlaceholder[];
  readonly placeholderMismatches: readonly PlaceholderMismatch[];
  readonly pluralFallbackGaps: readonly PluralFallbackGap[];
};

const PLURAL_KEY = /^(.*)_(zero|one|two|few|many|other)$/;

/** The `{name}` slots a phrase interpolates, deduplicated. */
export function placeholdersOf(phrase: string): ReadonlySet<string> {
  return inspectPlaceholderSyntax(phrase).names;
}

/**
 * Read one locale off a side-by-side phrase by tag rather than by property.
 *
 * A blank phrase is UNWRITTEN, not written-as-nothing: this is the check that
 * hands a translator their worklist, and a key holding `""` is exactly the work.
 *
 * The locale list is a parameter so a test can prove the multi-locale behavior
 * before a second locale ships; that costs this narrowing, which is honest
 * about a phrase object having been written by hand.
 */
function writtenPhraseFor(text: LocalizedText, locale: string): string | undefined {
  const phrases: Readonly<Record<string, unknown>> = text;
  const phrase = phrases[locale];
  return typeof phrase === "string" && phrase.trim().length > 0 ? phrase : undefined;
}

function comparePlaceholders(reference: string, translation: string): { missing: string[]; unexpected: string[] } {
  const expected = placeholdersOf(reference);
  const actual = placeholdersOf(translation);
  return {
    missing: [...expected].filter((name) => !actual.has(name)),
    unexpected: [...actual].filter((name) => !expected.has(name)),
  };
}

function findPluralFallbackGaps(merged: MergedCopy): PluralFallbackGap[] {
  const families = new Map<string, { readonly key: string; readonly file: string; hasOther: boolean }>();

  for (const [key, entry] of merged) {
    const match = PLURAL_KEY.exec(key);
    const baseKey = match?.[1];
    const category = match?.[2];
    if (baseKey === undefined || category === undefined) continue;

    const ownerAndKey = `${entry.file}\n${baseKey}`;
    const family = families.get(ownerAndKey) ?? {
      key: baseKey,
      file: entry.file,
      hasOther: false,
    };
    if (category === "other") family.hasOther = true;
    families.set(ownerAndKey, family);
  }

  return [...families.values()]
    .filter((family) => !family.hasOther)
    .map((family) => ({
      key: family.key,
      file: family.file,
      missingKey: `${family.key}_other`,
    }));
}

function recordMalformedPlaceholders(
  malformedPlaceholders: MalformedPlaceholder[],
  key: string,
  file: string,
  locale: string,
  phrase: string,
): boolean {
  const malformed = inspectPlaceholderSyntax(phrase).malformed;
  malformedPlaceholders.push(...malformed.map((token) => ({ key, file, locale, token })));
  return malformed.length > 0;
}

type PhraseFindings = {
  readonly missingTranslations: MissingTranslation[];
  readonly malformedPlaceholders: MalformedPlaceholder[];
  readonly placeholderMismatches: PlaceholderMismatch[];
};

function checkCatalogEntry(
  key: string,
  entry: { readonly file: string; readonly text: LocalizedText },
  reference: string,
  translated: readonly string[],
  findings: PhraseFindings,
): void {
  const { file, text } = entry;
  const referencePhrase = writtenPhraseFor(text, reference);
  if (referencePhrase === undefined) {
    findings.missingTranslations.push({ key, file, locale: reference });
    return;
  }
  const malformedReference = recordMalformedPlaceholders(
    findings.malformedPlaceholders,
    key,
    file,
    reference,
    referencePhrase,
  );
  for (const locale of translated) {
    const phrase = writtenPhraseFor(text, locale);
    if (phrase === undefined) {
      findings.missingTranslations.push({ key, file, locale });
      continue;
    }
    const malformedTranslation = recordMalformedPlaceholders(findings.malformedPlaceholders, key, file, locale, phrase);
    if (malformedReference || malformedTranslation) continue;
    const { missing, unexpected } = comparePlaceholders(referencePhrase, phrase);
    if (missing.length > 0 || unexpected.length > 0) {
      findings.placeholderMismatches.push({
        key,
        file,
        locale,
        missing,
        unexpected,
      });
    }
  }
}

/**
 * Every gap between the reference locale and the rest, as data.
 *
 * The reference is the first supported locale — the one every phrase is
 * written in first — and the rest are measured against it.
 */
export function checkCatalogParity(
  merged: MergedCopy,
  locales: readonly string[] = SUPPORTED_LOCALES,
): CatalogParityReport {
  const [reference, ...translated] = locales;
  if (reference === undefined) {
    throw new Error("catalog parity needs at least one locale to measure against");
  }

  const findings: PhraseFindings = {
    missingTranslations: [],
    malformedPlaceholders: [],
    placeholderMismatches: [],
  };
  for (const [key, entry] of merged) {
    checkCatalogEntry(key, entry, reference, translated, findings);
  }

  return { ...findings, pluralFallbackGaps: findPluralFallbackGaps(merged) };
}

function describeParityReport(report: CatalogParityReport): string {
  const lines = [
    ...report.missingTranslations.map((gap) => `  ${gap.key} (${gap.file}) has no ${gap.locale} phrase`),
    ...report.malformedPlaceholders.map(
      (gap) => `  ${gap.key} (${gap.file}) ${gap.locale} has malformed placeholder ${gap.token}`,
    ),
    ...report.placeholderMismatches.map(
      (gap) =>
        `  ${gap.key} (${gap.file}) ${gap.locale} placeholders differ — missing [${gap.missing.join(", ")}], unexpected [${gap.unexpected.join(", ")}]`,
    ),
    ...report.pluralFallbackGaps.map(
      (gap) => `  ${gap.key} (${gap.file}) plural family has no ${gap.missingKey} fallback`,
    ),
  ];
  return lines.join("\n");
}

/** Parity as a check: the failure message IS the translation worklist. */
export function assertCatalogParity(merged: MergedCopy, locales: readonly string[] = SUPPORTED_LOCALES): void {
  const report = checkCatalogParity(merged, locales);
  const gaps =
    report.missingTranslations.length +
    report.malformedPlaceholders.length +
    report.placeholderMismatches.length +
    report.pluralFallbackGaps.length;
  if (gaps === 0) return;
  throw new Error(
    `${String(gaps)} copy ${gaps === 1 ? "entry needs" : "entries need"} work:\n${describeParityReport(report)}`,
  );
}
