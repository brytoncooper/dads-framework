import { copy, type CopyDescriptor, type CopyVars, isCopyDescriptor } from "./copy-descriptor.js";
import { formatInteger, formatNumber } from "./locale-formatting.js";
import { type CopyCatalog, type Locale, resolveLocalizedText } from "./localized-text.js";
import { inspectPlaceholderSyntax } from "./placeholder-syntax.js";

/**
 * Turn a key into the sentence a reader sees.
 *
 * Three behaviors, and one refusal.
 *
 * **Interpolation** fills `{name}` slots from `vars`. **Plurals** pick
 * `<key>_one` / `<key>_other` through `Intl.PluralRules`, which is a browser
 * builtin and knows each language's own categories — Spanish has a `many` that
 * English does not, and the catalog can answer it without this file learning
 * grammar. **Nesting** resolves a `vars` value that is itself a descriptor
 * depth-first, so a sentence can carry an independently pluralized fragment.
 *
 * The refusal: a key the catalog does not declare THROWS. Rendering the key
 * would put `orders.page.titel` on a customer's screen and pass every test that
 * did not happen to read that string. Typed keys make this unreachable from
 * TypeScript; the throw covers the cases types cannot see, such as a plural
 * form the catalog forgot.
 */

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The plural categories a catalog may spell, as key suffixes. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/**
 * The base key behind a plural pair — `orders.holders` from
 * `orders.holders_one` / `orders.holders_other`.
 */
export type PluralBaseKey<Key extends string> = Key extends `${infer Base}_${PluralCategory}` ? Base : never;

/**
 * Every key a caller may name: the ones the catalog declares, plus the base of
 * each plural pair. A base key exists only because its suffixed forms do, so
 * the typed-key guarantee survives the plural idiom.
 */
export type CopyKey<Catalog extends CopyCatalog> = (keyof Catalog & string) | PluralBaseKey<keyof Catalog & string>;

function selectPluralKey(catalog: CopyCatalog, locale: Locale, key: string, count: number): string {
  const category = new Intl.PluralRules(locale).select(count);
  const candidates = [`${key}_${category}`, `${key}_other`, key];
  const declared = candidates.find((candidate) => catalog[candidate] !== undefined);
  if (declared === undefined) {
    throw new Error(
      `copy key "${key}" pluralizes but the catalog declares neither "${key}_${category}" nor "${key}_other"`,
    );
  }
  return declared;
}

function phraseFor(catalog: CopyCatalog, locale: Locale, descriptor: CopyDescriptor): string {
  const key =
    descriptor.count === undefined
      ? descriptor.key
      : selectPluralKey(catalog, locale, descriptor.key, descriptor.count);
  const text = catalog[key];
  if (text === undefined) {
    throw new Error(`copy key "${key}" is not declared in this catalog — a key is never rendered as itself`);
  }
  return resolveLocalizedText(text, locale);
}

function resolveVars(
  catalog: CopyCatalog,
  locale: Locale,
  descriptor: CopyDescriptor,
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  // A pluralized sentence almost always says its own number, so `{count}`
  // fills itself; an explicit var of the same name still wins.
  if (descriptor.count !== undefined) {
    resolved["count"] = formatInteger(descriptor.count, locale);
  }
  for (const [name, copyVariable] of Object.entries(descriptor.vars ?? {})) {
    resolved[name] = isCopyDescriptor(copyVariable)
      ? render(catalog, locale, copyVariable)
      : typeof copyVariable === "number"
        ? formatNumber(copyVariable, locale, { maximumFractionDigits: 20 })
        : copyVariable;
  }
  return resolved;
}

function interpolate(phrase: string, vars: Readonly<Record<string, string>>, key: string): string {
  const [malformed] = inspectPlaceholderSyntax(phrase).malformed;
  if (malformed !== undefined) {
    throw new Error(
      `copy key "${key}" contains malformed placeholder ${malformed}; use {name} with letters, numbers, or underscores`,
    );
  }

  let filled = "";
  let cursor = 0;
  for (const match of phrase.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name === undefined) continue;
    const replacement = vars[name];
    if (replacement === undefined) {
      throw new Error(`copy key "${key}" interpolates {${name}} and nothing was given for it`);
    }
    filled += phrase.slice(cursor, match.index) + replacement;
    cursor = match.index + match[0].length;
  }
  return filled + phrase.slice(cursor);
}

function render(catalog: CopyCatalog, locale: Locale, descriptor: CopyDescriptor): string {
  const phrase = phraseFor(catalog, locale, descriptor);
  return interpolate(phrase, resolveVars(catalog, locale, descriptor), descriptor.key);
}

/** Resolve a key or a descriptor against one catalog, in one language. */
export function translate(
  catalog: CopyCatalog,
  locale: Locale,
  keyOrDescriptor: string | CopyDescriptor,
  vars?: CopyVars,
  count?: number,
): string {
  const descriptor = isCopyDescriptor(keyOrDescriptor) ? keyOrDescriptor : copy(keyOrDescriptor, vars, count);
  return render(catalog, locale, descriptor);
}
