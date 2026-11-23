/**
 * `tsconfig.json` is JSON with comments and trailing commas, so `JSON.parse`
 * cannot read it directly. This removes both without a dependency and without
 * looking inside strings, so a `//` in a path stays part of that path. Comments
 * are replaced rather than deleted only for newlines, which keeps the parse
 * error a caller reports on the line the reader saw it.
 */
export function stripJsonComments(text: string): string {
  return removeTrailingCommas(removeComments(text));
}

/** A run of characters read as one thing, and where reading continues after it. */
type ScannedSpan = {
  readonly output: string;
  readonly next: number;
};

function removeComments(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === '"') {
      const literal = copyStringLiteral(text, index);
      output += literal.output;
      index = literal.next;
      continue;
    }
    const comment = scanComment(text, index);
    if (comment === undefined) {
      output += character;
      index += 1;
      continue;
    }
    output += comment.output;
    index = comment.next;
  }
  return output;
}

function removeTrailingCommas(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === '"') {
      const literal = copyStringLiteral(text, index);
      output += literal.output;
      index = literal.next;
      continue;
    }
    index += 1;
    if (character === "," && closesCollection(text, index)) continue;
    output += character;
  }
  return output;
}

/**
 * Copies a string literal verbatim, from its opening quote through its closing
 * one, so nothing inside it is ever read as syntax. An escape carries the
 * character after it, and an unterminated literal runs to the end of the text
 * for `JSON.parse` to report.
 */
function copyStringLiteral(text: string, from: number): ScannedSpan {
  let output = text[from] ?? "";
  let index = from + 1;
  while (index < text.length) {
    const character = text[index] ?? "";
    output += character;
    if (character === "\\") {
      output += text[index + 1] ?? "";
      index += 2;
      continue;
    }
    index += 1;
    if (character === '"') break;
  }
  return { output, next: index };
}

/** Reads the comment starting at `from`, or reports that none starts there. */
function scanComment(text: string, from: number): ScannedSpan | undefined {
  if (text[from] !== "/") return undefined;
  if (text[from + 1] === "/") {
    return { output: "", next: endOfLine(text, from) };
  }
  if (text[from + 1] !== "*") return undefined;
  return scanBlockComment(text, from + 2);
}

function endOfLine(text: string, from: number): number {
  let index = from;
  while (index < text.length && text[index] !== "\n") index += 1;
  return index;
}

/** A block comment contributes its newlines, so no later line changes number. */
function scanBlockComment(text: string, from: number): ScannedSpan {
  let output = "";
  let index = from;
  while (index < text.length) {
    if (text[index] === "*" && text[index + 1] === "/") break;
    if (text[index] === "\n") output += "\n";
    index += 1;
  }
  return { output, next: index + 2 };
}

/** A comma is trailing when the next thing that is not whitespace closes the collection. */
function closesCollection(text: string, from: number): boolean {
  const next = nextMeaningfulCharacter(text, from);
  return next === "}" || next === "]";
}

function nextMeaningfulCharacter(text: string, from: number): string | undefined {
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) return undefined;
    if (!" \t\r\n".includes(character)) return character;
  }
  return undefined;
}
