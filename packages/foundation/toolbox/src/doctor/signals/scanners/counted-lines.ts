/**
 * Counted lines: non-blank and non-comment.
 *
 * The count has to survive a formatter reflow and an added doc comment without
 * moving a mark, so blank lines and comments come out before anything is
 * counted. The stripper is string-aware for one reason: `//` inside a string
 * literal is code, and a URL in a string is the common case. It is a scanner,
 * not a parser, and it says so — the tokens it knows are line comments, block
 * comments, and string literals.
 *
 * Languages: TypeScript, JavaScript, and Rust. They share `//` and block
 * comments; they differ in their string literals. TypeScript and JavaScript get
 * single quotes, double quotes, and template literals. Rust gets double-quoted
 * and raw strings, both of which may span lines, and char literals, and it does
 * not get single quotes as a string delimiter because in Rust a lone `'` is
 * usually a lifetime.
 */

const RUST_CHAR_LITERAL = /^'(?:\\.|[^'\\])'/;
const RUST_RAW_STRING = /^r(#*)"/;

/** A string literal that is open, and what would close it. */
export type OpenStringLiteral = {
  readonly terminator: string;
  readonly escapes: boolean;
  readonly spans: boolean;
};

/** What one line left behind for the next one. */
export type StripState = {
  readonly block: boolean;
  readonly literal: OpenStringLiteral | undefined;
};

type ScanStep = {
  readonly text: string;
  readonly index: number;
  readonly block: boolean;
  readonly literal: OpenStringLiteral | undefined;
  readonly stop: boolean;
};

const CLEAN_START: StripState = { block: false, literal: undefined };

/** Counted lines in `text`, dispatching on the path's language. */
export function countCodeLines(text: string, path: string): number {
  const rust = path.endsWith(".rs");
  let state = CLEAN_START;
  let counted = 0;
  for (const line of text.split("\n")) {
    const stripped = stripCommentsFromLine(line, state, rust);
    state = stripped.state;
    if (stripped.code.trim().length > 0) counted += 1;
  }
  return counted;
}

/**
 * Removes comments from one line, carrying the block-comment and unterminated
 * string state to the next one. Returns the surviving code and the new state.
 */
export function stripCommentsFromLine(
  line: string,
  state: StripState,
  rust: boolean,
): { readonly code: string; readonly state: StripState } {
  let step: ScanStep = {
    text: "",
    index: 0,
    block: state.block,
    literal: state.literal,
    stop: false,
  };
  let code = "";
  while (!step.stop && step.index < line.length) {
    step = scanOnce(line, step, rust);
    code += step.text;
  }
  return { code, state: { block: step.block, literal: step.literal } };
}

function scanOnce(line: string, step: ScanStep, rust: boolean): ScanStep {
  if (step.block) return scanBlockComment(line, step.index);
  if (step.literal !== undefined) {
    return scanOpenLiteral(line, step.index, step.literal);
  }
  return scanCode(line, step.index, rust);
}

function scanBlockComment(line: string, index: number): ScanStep {
  const end = line.indexOf("*/", index);
  if (end === -1) {
    return {
      text: "",
      index: line.length,
      block: true,
      literal: undefined,
      stop: true,
    };
  }
  return {
    text: "",
    index: end + 2,
    block: false,
    literal: undefined,
    stop: false,
  };
}

/**
 * Scans to the end of an open string. The literal continues onto the next line
 * only when it legally may; an unterminated single- or double-quoted
 * JavaScript string is a syntax error, so the state resets instead of eating
 * the rest of the file.
 */
function scanOpenLiteral(
  line: string,
  index: number,
  literal: OpenStringLiteral,
): ScanStep {
  let position = index;
  while (position < line.length) {
    if (literal.escapes && line[position] === "\\") {
      position += 2;
      continue;
    }
    if (line.startsWith(literal.terminator, position)) {
      const end = position + literal.terminator.length;
      return {
        text: line.slice(index, end),
        index: end,
        block: false,
        literal: undefined,
        stop: false,
      };
    }
    position += 1;
  }
  return {
    text: line.slice(index),
    index: line.length,
    block: false,
    literal: literal.spans ? literal : undefined,
    stop: literal.spans,
  };
}

function scanCode(line: string, index: number, rust: boolean): ScanStep {
  const started = openLiteralAt(line, index, rust);
  if (started !== undefined) {
    return {
      text: line.slice(index, started.index),
      index: started.index,
      block: false,
      literal: started.literal,
      stop: false,
    };
  }
  if (line.startsWith("//", index)) {
    return {
      text: "",
      index: line.length,
      block: false,
      literal: undefined,
      stop: true,
    };
  }
  if (line.startsWith("/*", index)) {
    return {
      text: "",
      index: index + 2,
      block: true,
      literal: undefined,
      stop: false,
    };
  }
  return {
    text: line.slice(index, index + 1),
    index: index + 1,
    block: false,
    literal: undefined,
    stop: false,
  };
}

type LiteralStart = {
  readonly index: number;
  readonly literal: OpenStringLiteral | undefined;
};

/**
 * Recognizes a string literal beginning at `index`, returning the index just
 * past the opening delimiter and the terminator to look for. A Rust char
 * literal is consumed whole and opens nothing, which is what keeps `'"'` from
 * opening a string that never closes.
 */
function openLiteralAt(
  line: string,
  index: number,
  rust: boolean,
): LiteralStart | undefined {
  return rust
    ? openRustLiteralAt(line, index)
    : openScriptLiteralAt(line, index);
}

function openRustLiteralAt(
  line: string,
  index: number,
): LiteralStart | undefined {
  const rest = line.slice(index);
  const charLiteral = RUST_CHAR_LITERAL.exec(rest);
  if (charLiteral !== null) {
    return { index: index + charLiteral[0].length, literal: undefined };
  }
  const raw = RUST_RAW_STRING.exec(rest);
  if (raw !== null) {
    return {
      index: index + raw[0].length,
      literal: { terminator: `"${raw[1] ?? ""}`, escapes: false, spans: true },
    };
  }
  if (line[index] !== '"') return undefined;
  return {
    index: index + 1,
    literal: { terminator: '"', escapes: true, spans: true },
  };
}

function openScriptLiteralAt(
  line: string,
  index: number,
): LiteralStart | undefined {
  const character = line[index];
  if (character === '"' || character === "'") {
    return {
      index: index + 1,
      literal: { terminator: character, escapes: true, spans: false },
    };
  }
  if (character !== "`") return undefined;
  return {
    index: index + 1,
    literal: { terminator: "`", escapes: true, spans: true },
  };
}
