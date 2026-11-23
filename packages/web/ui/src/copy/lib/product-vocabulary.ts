import type { MergedCopy } from "./merge-copy.js";

/**
 * Words a product refuses on its own customer surfaces — the shape, not the
 * words.
 *
 * A refused word is the wrong name for something the product ships, and the
 * correction is a sentence rather than a swap.
 * Which words those are is the product's business, so only the three kinds of refusal live here.
 */

/** One catalog phrase that uses an internal noun on a customer surface. */
export type ProductVocabularyViolation = {
  readonly key: string;
  readonly file: string;
  readonly locale: string;
  readonly found: string;
  readonly guidance: string;
};

/**
 * One refused word, every spelling it takes, and what to write instead.
 *
 * Three kinds, because a refusal is rarely unconditional:
 *   - plain — the word is wrong wherever it appears;
 *   - `rightAfter` — the word is right in one compound and wrong alone, so the
 *     word before it decides (`work assignment` against `role assignment`);
 *   - `onlyAsAName` — the word is ordinary English and only wrong when it names
 *     a screen (`people with access` against a page called `People`).
 *
 * Matching is whole-word and, apart from `onlyAsAName`, case-insensitive; a
 * space inside a spelling matches any run of whitespace.
 */
export type RefusedWord = {
  readonly words: readonly string[];
  readonly guidance: string;
  readonly rightAfter?: string;
  readonly onlyAsAName?: true;
};

export type ProductVocabulary = readonly RefusedWord[];

/** Declare a product's refused words, exactly as `defineCopy` and `defineGlossary`. */
export function defineProductVocabulary<const T extends ProductVocabulary>(vocabulary: T): T {
  return vocabulary;
}

type ProductVocabularyFinding = {
  readonly found: string;
  readonly guidance: string;
};

/** Key segments that mean "this phrase NAMES something" rather than says it. */
const SURFACE_NAME_SEGMENTS = new Set([
  "action",
  "affordance",
  "button",
  "column",
  "heading",
  "label",
  "menu",
  "nav",
  "tab",
  "title",
]);
const UNICODE_WORD_START = "(?:^|[^\\p{L}\\p{N}_])";
const UNICODE_WORD_END = "(?=$|[^\\p{L}\\p{N}_])";
const NAMES_A_SURFACE_AFTER = /^\s+(?:area|page|screen|section)\b/iu;

function escaped(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every spelling as one alternation, longest spelling still reachable.
 *
 * `set` before `sets` would win at the same position, but the whole-word
 * lookahead refuses the shorter one and the regex falls through to the longer,
 * so the order the product wrote them in does not matter.
 */
function anySpellingOf(words: readonly string[]): string {
  return words.map((word) => escaped(word).replace(/\s+/g, "\\s+")).join("|");
}

function firstWholeWordMatch(phrase: string, spellings: string): string | undefined {
  const match = new RegExp(`${UNICODE_WORD_START}(${spellings})${UNICODE_WORD_END}`, "iu").exec(phrase);
  return match?.[1];
}

function isSurfaceNameKey(key: string): boolean {
  const segments = key.split(".");
  const last = segments.at(-1);
  return (
    segments.some((segment) => SURFACE_NAME_SEGMENTS.has(segment)) ||
    (last !== undefined && /(?:heading|label|title)$/i.test(last))
  );
}

/** Where the captured word starts in the phrase, past the boundary character. */
function matchStart(match: RegExpExecArray, found: string): number {
  return match.index + match[0].lastIndexOf(found);
}

/** The first use of the word that is NOT part of the compound it belongs to. */
function firstUseOutside(phrase: string, spellings: string, compoundStart: string): string | undefined {
  const uses = new RegExp(`${UNICODE_WORD_START}(${spellings})${UNICODE_WORD_END}`, "giu");

  for (const match of phrase.matchAll(uses)) {
    const found = match[1];
    if (found === undefined) continue;
    const before = phrase.slice(0, matchStart(match, found));
    const isCompound = new RegExp(`${UNICODE_WORD_START}${escaped(compoundStart)}\\s+$`, "iu").test(before);
    if (!isCompound) return found;
  }
  return undefined;
}

/** `people` becomes `People` — the one spelling that can be naming something. */
function asAName(word: string): string {
  const [first] = word;
  return first === undefined ? word : first.toLocaleUpperCase("en") + word.slice(1);
}

/**
 * The first use of the word AS A NAME: capitalized mid-phrase, or opening a
 * phrase that goes on to say area, page, screen or section.
 *
 * A phrase starts with a capital whatever it means, so position zero alone
 * proves nothing — that is the whole reason this is not a plain match.
 */
function firstUseAsAName(phrase: string, words: readonly string[]): string | undefined {
  const names = new RegExp(`${UNICODE_WORD_START}(${anySpellingOf(words.map(asAName))})${UNICODE_WORD_END}`, "gu");

  for (const match of phrase.matchAll(names)) {
    const found = match[1];
    if (found === undefined) continue;
    const start = matchStart(match, found);
    if (start > 0) return found;
    if (NAMES_A_SURFACE_AFTER.test(phrase.slice(start + found.length))) {
      return found;
    }
  }
  return undefined;
}

function foundIn(key: string, phrase: string, refused: RefusedWord): string | undefined {
  const spellings = anySpellingOf(refused.words);
  if (refused.onlyAsAName === true && !isSurfaceNameKey(key)) {
    return firstUseAsAName(phrase, refused.words);
  }
  if (refused.rightAfter !== undefined) {
    return firstUseOutside(phrase, spellings, refused.rightAfter);
  }
  return firstWholeWordMatch(phrase, spellings);
}

function findingsFor(key: string, phrase: string, vocabulary: ProductVocabulary): ProductVocabularyFinding[] {
  const findings: ProductVocabularyFinding[] = [];
  for (const refused of vocabulary) {
    const found = foundIn(key, phrase, refused);
    if (found !== undefined) {
      findings.push({ found, guidance: refused.guidance });
    }
  }
  return findings;
}

/** Find customer-facing nouns that conflict with a product's settled vocabulary. */
export function checkProductVocabulary(
  merged: MergedCopy,
  vocabulary: ProductVocabulary,
): readonly ProductVocabularyViolation[] {
  const violations: ProductVocabularyViolation[] = [];
  for (const [key, entry] of merged) {
    for (const finding of findingsFor(key, entry.text.en, vocabulary)) {
      violations.push({
        key,
        file: entry.file,
        locale: "en",
        ...finding,
      });
    }
  }
  return violations;
}
