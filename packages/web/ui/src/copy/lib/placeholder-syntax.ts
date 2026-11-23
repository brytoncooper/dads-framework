/** The interpolation names and malformed brace tokens authored in one phrase. */
export type PlaceholderSyntax = {
  readonly names: ReadonlySet<string>;
  readonly malformed: readonly string[];
};

const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read `{name}` slots while retaining malformed brace text for an actionable
 * authoring error. Placeholder names are code identifiers, not translated
 * prose, so their grammar stays deliberately ASCII and stable across locales.
 */
export function inspectPlaceholderSyntax(phrase: string): PlaceholderSyntax {
  const names = new Set<string>();
  const malformed: string[] = [];
  let cursor = 0;

  while (cursor < phrase.length) {
    const opening = phrase.indexOf("{", cursor);
    const closing = phrase.indexOf("}", cursor);

    if (closing !== -1 && (opening === -1 || closing < opening)) {
      malformed.push("}");
      cursor = closing + 1;
      continue;
    }
    if (opening === -1) break;

    const end = phrase.indexOf("}", opening + 1);
    if (end === -1) {
      malformed.push(phrase.slice(opening));
      break;
    }

    const token = phrase.slice(opening, end + 1);
    const name = phrase.slice(opening + 1, end);
    if (PLACEHOLDER_NAME.test(name)) names.add(name);
    else malformed.push(token);
    cursor = end + 1;
  }

  return { names, malformed };
}
