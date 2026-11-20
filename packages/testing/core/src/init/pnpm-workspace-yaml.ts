/**
 * The one shape of `pnpm-workspace.yaml` that `dad-test init` needs: a
 * `packages:` list of strings, plus whatever other top-level keys the file
 * carries (`catalog:` and friends), which are reported rather than read. This
 * is deliberately not a YAML parser. Everything it cannot read with certainty —
 * anchors, aliases, block scalars, tabs, nested maps, a second document — is
 * refused at the line it appears on, because a half-understood workspace file
 * produces a manifest that silently omits projects.
 */

export type ParsedPnpmWorkspaceFile = {
  readonly packages: readonly string[];
  readonly ignoredKeys: readonly string[];
};

type ReadingMode = "top-level" | "packages" | "ignored";

/** Builds the one error this reader raises; the caller throws it. */
type UnsupportedYaml = () => Error;

/** Everything the reader carries from one line to the next. */
type WorkspaceFileReader = {
  readonly packages: string[];
  readonly ignoredKeys: string[];
  mode: ReadingMode;
  packagesSeen: boolean;
  documentStarted: boolean;
};

const topLevelKeyPattern = /^([A-Za-z0-9_.-]+):(.*)$/;
const listItemPattern = /^-(?:\s+(.*))?$/;
const aliasOrAnchorPattern = /^[*&]/;

export function parsePnpmWorkspaceFile(
  text: string,
  filePath: string,
): ParsedPnpmWorkspaceFile {
  const lines = text.split(/\r?\n/);
  const reader: WorkspaceFileReader = {
    packages: [],
    ignoredKeys: [],
    mode: "top-level",
    packagesSeen: false,
    documentStarted: false,
  };

  for (const [index, line] of lines.entries()) {
    readOneLine(
      reader,
      line,
      () => new Error(unsupportedMessage(filePath, index + 1)),
    );
  }

  if (!reader.packagesSeen) {
    throw new Error(unsupportedMessage(filePath, Math.max(lines.length, 1)));
  }
  return { packages: reader.packages, ignoredKeys: reader.ignoredKeys };
}

function unsupportedMessage(filePath: string, line: number): string {
  return `${filePath}:${String(line)}: unsupported YAML; dad-test init reads only a packages: list of strings.`;
}

/** A tab, a blank, a comment, or the document marker; anything else carries content. */
function readOneLine(
  reader: WorkspaceFileReader,
  line: string,
  unsupported: UnsupportedYaml,
): void {
  if (line.includes("\t")) throw unsupported();
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return;
  if (trimmed === "---") {
    if (reader.documentStarted) throw unsupported();
    reader.documentStarted = true;
    return;
  }
  reader.documentStarted = true;
  readContentLine(reader, line, trimmed, unsupported);
}

/** Content is a list item, an indented block, or a top-level key. */
function readContentLine(
  reader: WorkspaceFileReader,
  line: string,
  trimmed: string,
  unsupported: UnsupportedYaml,
): void {
  const listItem = listItemPattern.exec(trimmed);
  if (listItem !== null) {
    readListItem(reader, listItem[1] ?? "", unsupported);
    return;
  }
  if (/^\s/.test(line)) {
    // Indentation that is not a list item: a nested map, or a stray block.
    if (reader.mode === "ignored") return;
    throw unsupported();
  }
  readTopLevelKey(reader, line, unsupported);
}

/** A list item belongs to `packages:`; under any other key it is skipped. */
function readListItem(
  reader: WorkspaceFileReader,
  rawValue: string,
  unsupported: UnsupportedYaml,
): void {
  if (reader.mode === "ignored") return;
  if (reader.mode !== "packages") throw unsupported();
  reader.packages.push(readScalar(rawValue, unsupported));
}

/**
 * `packages:` either opens a block list or carries a flow list on the same
 * line, and may appear once. Every other key is recorded and its block skipped.
 */
function readTopLevelKey(
  reader: WorkspaceFileReader,
  line: string,
  unsupported: UnsupportedYaml,
): void {
  const keyed = topLevelKeyPattern.exec(line);
  if (keyed === null) throw unsupported();
  if (keyed[1] !== "packages") {
    reader.mode = "ignored";
    reader.ignoredKeys.push(keyed[1] ?? "");
    return;
  }
  if (reader.packagesSeen) throw unsupported();
  reader.packagesSeen = true;
  const rest = (keyed[2] ?? "").trim();
  if (rest.length === 0 || rest.startsWith("#")) {
    reader.mode = "packages";
    return;
  }
  reader.mode = "top-level";
  reader.packages.push(...readFlowList(rest, unsupported));
}

/** Reads one bare, 'single' or "double" quoted scalar; escapes are not supported. */
function readScalar(rawValue: string, unsupported: UnsupportedYaml): string {
  const value = stripTrailingComment(rawValue).trim();
  if (value.length === 0) throw unsupported();
  if (value.startsWith("'")) return readQuotedScalar(value, "'", unsupported);
  if (value.startsWith('"')) {
    const inner = readQuotedScalar(value, '"', unsupported);
    // Escapes are not interpreted, so a backslash cannot be read with certainty.
    if (inner.includes("\\")) throw unsupported();
    return inner;
  }
  return readBareScalar(value, unsupported);
}

/** A quoted scalar must close with its own quote and carry none of it inside. */
function readQuotedScalar(
  value: string,
  quote: "'" | '"',
  unsupported: UnsupportedYaml,
): string {
  if (value.length < 2 || !value.endsWith(quote)) throw unsupported();
  const inner = value.slice(1, -1);
  if (inner.includes(quote)) throw unsupported();
  return inner;
}

/**
 * A bare scalar is refused when it opens something this reader does not
 * understand: an alias or anchor, a block scalar, a flow collection, or a
 * nested mapping.
 */
function readBareScalar(value: string, unsupported: UnsupportedYaml): string {
  const opensUnreadableConstruct =
    aliasOrAnchorPattern.test(value) ||
    value.startsWith("|") ||
    value.startsWith(">") ||
    value.startsWith("[") ||
    value.startsWith("{");
  if (opensUnreadableConstruct) throw unsupported();
  if (value.endsWith(":") || value.includes(": ")) throw unsupported();
  return value;
}

function readFlowList(
  rest: string,
  unsupported: UnsupportedYaml,
): readonly string[] {
  const body = stripFlowComment(rest);
  if (!body.startsWith("[") || !body.endsWith("]")) throw unsupported();
  const inner = body.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((item) => readScalar(item, unsupported));
}

/** A `#` starts a comment only when it follows whitespace, as in YAML. */
function stripTrailingComment(value: string): string {
  if (value.startsWith("#")) return "";
  const comment = / #/.exec(value);
  return comment === null ? value : value.slice(0, comment.index);
}

function stripFlowComment(value: string): string {
  const closing = value.lastIndexOf("]");
  return closing === -1 ? value : value.slice(0, closing + 1).trim();
}
