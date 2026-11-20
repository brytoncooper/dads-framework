/**
 * A person's initials: one letter for a single name, first+last otherwise.
 *
 * Plain (non-locale) case folding on purpose: this is a decorative avatar
 * abbreviation, not translated copy, so it does not go through the copy-kit
 * locale-formatting seam.
 */
export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }

  const firstLetter = firstCharOf(words[0]);
  if (words.length === 1) {
    return firstLetter?.toUpperCase() ?? "?";
  }

  const lastLetter = firstCharOf(words[words.length - 1]);
  if (!firstLetter || !lastLetter) {
    return "?";
  }

  return (firstLetter + lastLetter).toUpperCase();
}

/** The first character of a word, astral-safe (surrogate pairs stay whole). */
function firstCharOf(word: string | undefined): string | undefined {
  return word === undefined ? undefined : Array.from(word)[0];
}
