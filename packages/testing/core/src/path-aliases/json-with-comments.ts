/**
 * A tsconfig is JSON with comments and trailing commas, which `JSON.parse`
 * cannot read. This is the package's own reader for that dialect, so resolving
 * an alias never needs the TypeScript compiler: TypeScript 7 ships no
 * JavaScript API, and an adopter's compiler version is their business rather
 * than this plugin's.
 *
 * The text is tokenized rather than matched with patterns, because a string
 * may contain a comment opener, a comment closer, and escaped quotes that are
 * content and not syntax. Text this reader cannot parse fails with the line
 * and column it stopped at.
 */

const punctuationCharacters = "{}[]:,";
const whitespaceCharacters = " \t\r\n";
/** An editor may have written a byte-order mark before the first brace. */
const byteOrderMark = 0xfe_ff;

/** One run of characters read as a single thing, and where it starts. */
type JsonToken = {
  readonly text: string;
  readonly offset: number;
  readonly punctuation: boolean;
};

/**
 * The text, how far reading has got, and the one token already read but not
 * yet used. Tokens are read as the parser asks for them, so a file stops at
 * the first thing that is wrong where it is, rather than at the first thing
 * that is wrong anywhere.
 */
type TokenCursor = {
  readonly source: string;
  offset: number;
  pending: JsonToken | undefined;
};

export function parseJsonWithComments(source: string): unknown {
  const cursor: TokenCursor = { source, offset: 0, pending: undefined };
  const value = readValue(cursor);
  const trailing = nextToken(cursor);
  if (trailing !== undefined) {
    throw syntaxError(source, trailing.offset, "expected the end of the file");
  }
  return value;
}

// --- Tokens --------------------------------------------------------------

/** Whitespace, a byte-order mark, and comments are all read as nothing. */
function skipIgnorable(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    if (isBlank(source[index])) {
      index += 1;
      continue;
    }
    const comment = commentEnd(source, index);
    if (comment === undefined) return index;
    index = comment;
  }
  return index;
}

/** Where the comment starting at `from` ends, or nothing when none starts there. */
function commentEnd(source: string, from: number): number | undefined {
  if (source[from] !== "/") return undefined;
  const second = source[from + 1];
  if (second === "/") {
    const newline = source.indexOf("\n", from + 2);
    return newline === -1 ? source.length : newline + 1;
  }
  if (second !== "*") return undefined;
  const closing = source.indexOf("*/", from + 2);
  if (closing === -1) {
    throw syntaxError(source, from, "expected the end of a block comment");
  }
  return closing + 2;
}

function readToken(source: string, offset: number): JsonToken {
  const character = source[offset];
  if (character !== undefined && punctuationCharacters.includes(character)) {
    return { text: character, offset, punctuation: true };
  }
  const text =
    character === '"'
      ? readStringLiteral(source, offset)
      : readBareLiteral(source, offset);
  return { text, offset, punctuation: false };
}

/**
 * From the opening quote to the matching one. A backslash carries the
 * character after it, so an escaped quote never ends the string and a comment
 * opener inside one stays content.
 */
function readStringLiteral(source: string, offset: number): string {
  let index = offset + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (character === '"') return source.slice(offset, index);
  }
  throw syntaxError(source, offset, "expected the end of a string");
}

/** A number, `true`, `false`, `null`, or whatever else was written there. */
function readBareLiteral(source: string, offset: number): string {
  let index = offset + 1;
  while (index < source.length && !endsBareLiteral(source, index)) index += 1;
  return source.slice(offset, index);
}

function endsBareLiteral(source: string, index: number): boolean {
  const character = source[index];
  if (character === undefined) return true;
  if (isBlank(character) || character === '"') return true;
  if (punctuationCharacters.includes(character)) return true;
  const following = source[index + 1];
  return character === "/" && (following === "/" || following === "*");
}

function isBlank(character: string | undefined): boolean {
  if (character === undefined) return false;
  return (
    whitespaceCharacters.includes(character) ||
    character.codePointAt(0) === byteOrderMark
  );
}

// --- Values --------------------------------------------------------------

function readValue(cursor: TokenCursor): unknown {
  const token = requireToken(cursor, "expected a value");
  if (token.text === "{") return readObject(cursor);
  if (token.text === "[") return parseJsonArray(cursor);
  if (token.punctuation) {
    throw syntaxError(cursor.source, token.offset, "expected a value");
  }
  return literalValue(cursor.source, token);
}

function readObject(cursor: TokenCursor): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (consume(cursor, "}")) return value;
  for (;;) {
    const name = requireToken(cursor, "expected a property name");
    const key = propertyName(cursor.source, name);
    requirePunctuation(cursor, ":", "expected a colon after a property name");
    value[key] = readValue(cursor);
    if (readSeparator(cursor, "}")) return value;
  }
}

function parseJsonArray(cursor: TokenCursor): readonly unknown[] {
  const values: unknown[] = [];
  if (consume(cursor, "]")) return values;
  for (;;) {
    values.push(readValue(cursor));
    if (readSeparator(cursor, "]")) return values;
  }
}

/**
 * Reads what separates one member from the next and reports whether the
 * collection is finished: the closing bracket ends it, and a comma continues
 * it — including a trailing comma, which a tsconfig is allowed to carry.
 */
function readSeparator(cursor: TokenCursor, closing: "}" | "]"): boolean {
  const expectation = `expected a comma or ${closing}`;
  const token = requireToken(cursor, expectation);
  if (token.text === closing) return true;
  if (token.text !== ",") {
    throw syntaxError(cursor.source, token.offset, expectation);
  }
  return consume(cursor, closing);
}

function propertyName(source: string, token: JsonToken): string {
  const value: unknown = token.punctuation
    ? undefined
    : jsonValueOrNothing(token.text);
  if (typeof value !== "string") {
    throw syntaxError(source, token.offset, "expected a property name");
  }
  return value;
}

function literalValue(source: string, token: JsonToken): unknown {
  try {
    return JSON.parse(token.text);
  } catch {
    throw syntaxError(source, token.offset, "expected a value");
  }
}

/** The text's JSON value, or nothing when JSON does not accept that text. */
function jsonValueOrNothing(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// --- The cursor ----------------------------------------------------------

/** Reads the next token, or reports the end of the text, without consuming it. */
function peekToken(cursor: TokenCursor): JsonToken | undefined {
  if (cursor.pending !== undefined) return cursor.pending;
  const start = skipIgnorable(cursor.source, cursor.offset);
  cursor.offset = start;
  if (start >= cursor.source.length) return undefined;
  const token = readToken(cursor.source, start);
  cursor.pending = token;
  cursor.offset = token.offset + token.text.length;
  return token;
}

function nextToken(cursor: TokenCursor): JsonToken | undefined {
  const token = peekToken(cursor);
  cursor.pending = undefined;
  return token;
}

function requireToken(cursor: TokenCursor, expectation: string): JsonToken {
  const token = nextToken(cursor);
  if (token === undefined) {
    throw syntaxError(cursor.source, cursor.source.length, expectation);
  }
  return token;
}

/** Takes the next token when it reads `text`, and leaves the cursor otherwise. */
function consume(cursor: TokenCursor, text: string): boolean {
  if (peekToken(cursor)?.text !== text) return false;
  cursor.pending = undefined;
  return true;
}

function requirePunctuation(
  cursor: TokenCursor,
  text: string,
  expectation: string,
): void {
  const token = requireToken(cursor, expectation);
  if (token.text !== text) {
    throw syntaxError(cursor.source, token.offset, expectation);
  }
}

// --- Positions -----------------------------------------------------------

/** Every failure names where reading stopped, in the file's own coordinates. */
function syntaxError(
  source: string,
  offset: number,
  expectation: string,
): Error {
  const position = positionOf(source, offset);
  return new Error(
    `${expectation} at line ${position.line}, column ${position.column}`,
  );
}

function positionOf(
  source: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const end = Math.min(offset, source.length);
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < end; index += 1) {
    if (source[index] !== "\n") continue;
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: end - lineStart + 1 };
}
