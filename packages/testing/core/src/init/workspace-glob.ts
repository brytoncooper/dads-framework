import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * The subset of workspace globbing that `dad-test init` supports: literal
 * segments, `*` inside one segment, `**` across segments, and a leading `!` to
 * remove directories a previous pattern selected. Anything richer — brace
 * expansion, character classes, `?` — is refused by name rather than guessed
 * at, because a silently misread pattern produces a manifest that omits real
 * projects without saying so.
 */

export type CompiledWorkspaceGlob = {
  readonly pattern: string;
  readonly negated: boolean;
  readonly matches: (relativeDirectory: string) => boolean;
};

const unsupportedCharacters = ["?", "[", "]", "{", "}", "(", ")"];

/** Compiles one workspace pattern into a match over workspace-relative directories. */
export function compileWorkspaceGlob(pattern: string): CompiledWorkspaceGlob {
  const negated = pattern.startsWith("!");
  const body = normalizePath(negated ? pattern.slice(1) : pattern);
  for (const character of unsupportedCharacters) {
    if (!body.includes(character)) continue;
    throw new Error(
      `Unsupported workspace pattern ${pattern}; dad-test init understands literal segments, *, ** and a leading !.`,
    );
  }
  const patternSegments = body.split("/");
  return {
    pattern,
    negated,
    matches: (relativeDirectory: string): boolean =>
      matchSegments(
        patternSegments,
        0,
        normalizePath(relativeDirectory).split("/"),
        0,
      ),
  };
}

/**
 * Returns every workspace-relative directory that holds a `package.json` and is
 * selected by the patterns, sorted. Patterns are applied in order, so a later
 * negation removes what an earlier pattern selected.
 */
export function expandWorkspaceGlobs(
  workspaceRoot: string,
  patterns: readonly string[],
): readonly string[] {
  const globs = patterns.map((pattern) => compileWorkspaceGlob(pattern));
  const depth = searchDepthForPatterns(patterns);
  if (depth === 0) return [];
  const candidates = collectPackageDirectories(workspaceRoot, "", depth);
  return candidates.filter((directory) => isSelected(globs, directory)).sort();
}

/**
 * How deep the walk must go to satisfy the positive patterns. `**` matches any
 * number of segments, so one unbounded pattern makes the whole walk unbounded.
 */
function searchDepthForPatterns(patterns: readonly string[]): number {
  let depth = 0;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const segments = normalizePath(pattern).split("/");
    if (segments.includes("**")) return Number.POSITIVE_INFINITY;
    depth = Math.max(depth, segments.length);
  }
  return depth;
}

function collectPackageDirectories(
  workspaceRoot: string,
  relativeDirectory: string,
  remainingDepth: number,
): string[] {
  if (remainingDepth <= 0) return [];
  const absoluteDirectory =
    relativeDirectory === ""
      ? workspaceRoot
      : join(workspaceRoot, relativeDirectory);
  const found: string[] = [];
  for (const entry of readDirectoryEntries(absoluteDirectory)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child =
      relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
    if (existsSync(join(workspaceRoot, child, "package.json"))) {
      found.push(child);
    }
    found.push(
      ...collectPackageDirectories(workspaceRoot, child, remainingDepth - 1),
    );
  }
  return found;
}

/** An unreadable directory contributes no packages; the walk is best effort. */
function readDirectoryEntries(directory: string): readonly Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isSelected(
  globs: readonly CompiledWorkspaceGlob[],
  directory: string,
): boolean {
  let selected = false;
  for (const glob of globs) {
    if (!glob.matches(directory)) continue;
    selected = !glob.negated;
  }
  return selected;
}

function matchSegments(
  patternSegments: readonly string[],
  patternIndex: number,
  pathSegments: readonly string[],
  pathIndex: number,
): boolean {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }
  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === undefined) return false;
  if (patternSegment === "**") {
    for (let skip = pathIndex; skip <= pathSegments.length; skip += 1) {
      if (
        matchSegments(patternSegments, patternIndex + 1, pathSegments, skip)
      ) {
        return true;
      }
    }
    return false;
  }
  const pathSegment = pathSegments[pathIndex];
  if (pathSegment === undefined) return false;
  if (!matchOneSegment(patternSegment, pathSegment)) return false;
  return matchSegments(
    patternSegments,
    patternIndex + 1,
    pathSegments,
    pathIndex + 1,
  );
}

/**
 * One segment matches when the literal text around its `*`s is present: the
 * ends are anchored, and each literal between two `*`s appears in order in
 * what is left.
 */
function matchOneSegment(patternSegment: string, value: string): boolean {
  const parts = patternSegment.split("*");
  if (parts.length === 1) return patternSegment === value;
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (!matchesAnchoredEnds(value, first, last)) return false;
  return containsInOrder(
    value,
    parts.slice(1, -1),
    first.length,
    value.length - last.length,
  );
}

/** The text before the first `*` and after the last must sit at the ends without overlapping. */
function matchesAnchoredEnds(
  value: string,
  first: string,
  last: string,
): boolean {
  if (value.length < first.length + last.length) return false;
  return value.startsWith(first) && value.endsWith(last);
}

/** Each literal must be found after the previous one and before the anchored tail. */
function containsInOrder(
  value: string,
  literals: readonly string[],
  from: number,
  end: number,
): boolean {
  let cursor = from;
  for (const literal of literals) {
    if (literal.length === 0) continue;
    const found = value.indexOf(literal, cursor);
    if (found === -1 || found + literal.length > end) return false;
    cursor = found + literal.length;
  }
  return true;
}

/** Strips a leading `./` and any trailing slash, so a pattern reads one way only. */
function normalizePath(value: string): string {
  let normalized = value;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}
