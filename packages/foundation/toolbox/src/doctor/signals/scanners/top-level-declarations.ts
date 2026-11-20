/**
 * What a module declares at its top level, read from a skeleton of the source.
 *
 * Two signals need the same fact and neither may guess at it from a pattern
 * over raw text: a `function` inside a template literal is not a declaration,
 * and a nested helper is not a top-level one. So the text is scanned once into
 * a skeleton — comments removed, string contents removed, bracket depth
 * tracked — and both questions are asked of that.
 *
 * A skeleton is not a parser, and this file is honest about being the smaller
 * thing. The phase that builds the TypeScript program replaces it with
 * `context.program()`, and until then the parity test holds the skeleton to
 * the same answers the parser gives on every production file in this
 * repository.
 */

const OPENING = new Set(["{", "(", "["]);
const CLOSING = new Set(["}", ")", "]"]);
const FUNCTION_DECLARATION =
  /^(?:export\s+)?(?:declare\s+|default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const RE_EXPORT_HEAD = /^export\s+(?:type\s+)?(?:\*|\{)/;
const RE_EXPORT_SOURCE = /\bfrom\s*["'`]/;

/** One line of the skeleton, with the bracket depth on either side of it. */
export type SkeletonLine = {
  readonly text: string;
  readonly startDepth: number;
  readonly endDepth: number;
};

type ScanState = {
  readonly block: boolean;
  readonly terminator: string | undefined;
  readonly depth: number;
  /** The last significant character, which is how a regex is told from a divide. */
  readonly previous: string;
};

const CLEAN: ScanState = {
  block: false,
  terminator: undefined,
  depth: 0,
  previous: "",
};

/** A `/` starts a regular expression only where a value may start. */
const VALUE_MAY_START = /[A-Za-z0-9_$)\]}.]/;

/** Comments removed, string contents removed, bracket depth per line. */
export function readCodeSkeleton(text: string): readonly SkeletonLine[] {
  const lines: SkeletonLine[] = [];
  let state = CLEAN;
  for (const line of text.split("\n")) {
    const startDepth = state.depth;
    const scanned = skeletonOfLine(line, state);
    state = scanned.state;
    lines.push({
      text: scanned.text,
      startDepth,
      endDepth: state.depth,
    });
  }
  return lines;
}

function skeletonOfLine(
  line: string,
  state: ScanState,
): { readonly text: string; readonly state: ScanState } {
  let current = state;
  let text = "";
  let index = 0;
  while (index < line.length) {
    const step = current.block
      ? leaveBlockComment(line, index, current)
      : stepThroughCode(line, index, current);
    text += step.text;
    current = step.state;
    if (step.index === index) break;
    index = step.index;
  }
  return { text, state: current };
}

type ScanOutcome = {
  readonly text: string;
  readonly index: number;
  readonly state: ScanState;
};

function leaveBlockComment(
  line: string,
  index: number,
  state: ScanState,
): ScanOutcome {
  const end = line.indexOf("*/", index);
  if (end === -1) return { text: "", index: line.length, state };
  return { text: "", index: end + 2, state: { ...state, block: false } };
}

function stepThroughCode(
  line: string,
  index: number,
  state: ScanState,
): ScanOutcome {
  if (state.terminator !== undefined) {
    return skipLiteral(line, index, state, state.terminator);
  }
  if (line.startsWith("//", index)) {
    return { text: "", index: line.length, state };
  }
  if (line.startsWith("/*", index)) {
    return { text: "", index: index + 2, state: { ...state, block: true } };
  }
  const character = line.slice(index, index + 1);
  if (character === "/" && !VALUE_MAY_START.test(state.previous)) {
    return skipRegularExpression(line, index, state);
  }
  if (character === '"' || character === "'" || character === "`") {
    return {
      text: character,
      index: index + 1,
      state: { ...state, terminator: character, previous: character },
    };
  }
  return {
    text: character,
    index: index + 1,
    state: {
      ...state,
      depth: nextDepth(state.depth, character),
      previous: character.trim().length === 0 ? state.previous : character,
    },
  };
}

function nextDepth(depth: number, character: string): number {
  if (OPENING.has(character)) return depth + 1;
  if (CLOSING.has(character)) return Math.max(0, depth - 1);
  return depth;
}

/**
 * Skips a regular expression literal. Its brackets and quotes are pattern, not
 * syntax: `/^\//` carries what looks like a line comment and `/['"]/` what
 * looks like an unterminated string, and reading either as code puts the rest
 * of the module at the wrong depth.
 */
function skipRegularExpression(
  line: string,
  index: number,
  state: ScanState,
): ScanOutcome {
  let position = index + 1;
  let insideClass = false;
  while (position < line.length) {
    const character = line[position];
    if (character === "\\") {
      position += 2;
      continue;
    }
    if (character === "[") insideClass = true;
    else if (character === "]") insideClass = false;
    else if (character === "/" && !insideClass) {
      return {
        text: "",
        index: position + 1,
        state: { ...state, previous: "/" },
      };
    }
    position += 1;
  }
  return { text: "", index: line.length, state: { ...state, previous: "/" } };
}

/**
 * Skips a string literal's contents and emits only its delimiters, so a
 * declaration a renderer writes into a template literal is not read as a
 * declaration of this module.
 */
function skipLiteral(
  line: string,
  index: number,
  state: ScanState,
  terminator: string,
): ScanOutcome {
  let position = index;
  while (position < line.length) {
    if (line[position] === "\\") {
      position += 2;
      continue;
    }
    if (line[position] === terminator) {
      return {
        text: terminator,
        index: position + 1,
        state: { ...state, terminator: undefined, previous: terminator },
      };
    }
    position += 1;
  }
  const spans = terminator === "`";
  return {
    text: "",
    index: line.length,
    state: { ...state, terminator: spans ? terminator : undefined },
  };
}

// ---------------------------------------------------------------------------
// The two questions
// ---------------------------------------------------------------------------

/**
 * Every distinct name a top-level `function` statement declares. A set, so an
 * overload pair counts its file once: the signal counts files, not
 * declarations.
 */
export function topLevelFunctionNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of readCodeSkeleton(text)) {
    if (line.startDepth !== 0) continue;
    const declared = FUNCTION_DECLARATION.exec(line.text.trim());
    const name = declared?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** Every top-level statement, folded onto one line each. */
export function topLevelStatements(text: string): readonly string[] {
  const statements: string[] = [];
  let current = "";
  for (const line of readCodeSkeleton(text)) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0) continue;
    current = current.length === 0 ? trimmed : `${current} ${trimmed}`;
    if (
      line.endDepth === 0 &&
      (trimmed.endsWith(";") || trimmed.endsWith("}"))
    ) {
      statements.push(current);
      current = "";
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

/** True for `export … from "…"`, the only statement a barrel may hold. */
export function isReExportStatement(statement: string): boolean {
  return RE_EXPORT_HEAD.test(statement) && RE_EXPORT_SOURCE.test(statement);
}
