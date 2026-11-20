/**
 * The comments in a TypeScript or JavaScript file, one entry per line.
 *
 * Three signals ask a question of what somebody wrote in a comment, and none
 * of them may ask it of raw text: a suppression quoted inside a string literal
 * is a quotation, and a `//` inside a URL is not a comment at all. So the file
 * is scanned once into its comments, string literals skipped, and the
 * questions are asked of those.
 *
 * A block comment is returned as one entry per line rather than one entry per
 * block, because every reading these signals produce carries a line a reader
 * opens, and "somewhere in the doc comment above" is not that.
 *
 * This is a scanner, not a parser, and its one known blind spot is the regular
 * expression literal: `/['"]/` opens a string it never closes, and the rest of
 * that line is read as string rather than as code. The cost is a missed
 * comment on that line, never an invented one, because everything the scanner
 * mistakes for a string is text it then declines to report.
 */

/** One comment line, and the 1-based line of the file it sits on. */
export type SourceComment = {
  readonly line: number;
  readonly text: string;
};

type ScanStep = {
  readonly index: number;
  readonly line: number;
  readonly comments: readonly SourceComment[];
};

const QUOTES = new Set(['"', "'", "`"]);
const NONE: readonly SourceComment[] = [];

/** Every comment line in `source`, in the order the file writes them. */
export function scanComments(source: string): readonly SourceComment[] {
  const found: SourceComment[] = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const step = stepThroughSource(source, index, line);
    found.push(...step.comments);
    index = step.index;
    line = step.line;
  }
  return found;
}

/** True when a comment carries a description at least `least` characters long. */
export function hasDescriptionAfter(
  comment: string,
  mark: string,
  least: number,
): boolean {
  const at = comment.indexOf(mark);
  if (at === -1) return false;
  const described = comment.slice(at + mark.length).replace(/[*/\s]+$/, "");
  return described.trim().length >= least;
}

function stepThroughSource(
  source: string,
  index: number,
  line: number,
): ScanStep {
  if (source.startsWith("//", index)) {
    return takeLineComment(source, index, line);
  }
  if (source.startsWith("/*", index)) {
    return takeBlockComment(source, index, line);
  }
  const character = source.slice(index, index + 1);
  if (QUOTES.has(character)) {
    return skipStringLiteral(source, index, line, character);
  }
  return {
    index: index + 1,
    line: character === "\n" ? line + 1 : line,
    comments: NONE,
  };
}

function takeLineComment(
  source: string,
  index: number,
  line: number,
): ScanStep {
  const newline = source.indexOf("\n", index);
  const stop = newline === -1 ? source.length : newline;
  return {
    index: stop,
    line,
    comments: [{ line, text: source.slice(index + 2, stop) }],
  };
}

function takeBlockComment(
  source: string,
  index: number,
  line: number,
): ScanStep {
  const closed = source.indexOf("*/", index + 2);
  const stop = closed === -1 ? source.length : closed;
  const body = source.slice(index + 2, stop).split("\n");
  return {
    index: closed === -1 ? source.length : closed + 2,
    line: line + body.length - 1,
    comments: body.map((text, offset) => ({ line: line + offset, text })),
  };
}

/**
 * Skips a string literal. Only a template literal may span a line; an
 * unterminated quote is a syntax error, so the scan resumes at the next line
 * rather than swallowing the rest of the file.
 */
function skipStringLiteral(
  source: string,
  index: number,
  line: number,
  quote: string,
): ScanStep {
  let position = index + 1;
  let current = line;
  while (position < source.length) {
    const character = source.slice(position, position + 1);
    if (character === "\\") {
      position += 2;
      continue;
    }
    if (character === quote) break;
    if (character === "\n") {
      current += 1;
      if (quote !== "`")
        return { index: position + 1, line: current, comments: NONE };
    }
    position += 1;
  }
  return {
    index: Math.min(position + 1, source.length),
    line: current,
    comments: NONE,
  };
}
