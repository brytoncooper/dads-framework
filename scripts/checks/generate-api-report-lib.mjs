/**
 * Reading a package's public surface, and writing it down.
 *
 * A package's public surface is not its source. It is the `.d.ts` a consumer
 * compiles against, and it changes by accident — a widened parameter, an
 * internal helper that leaked through a barrel, a type that quietly stopped
 * being exported. This module resolves a package's entry points to their
 * emitted declarations, asks the TypeScript checker what each one exports, and
 * renders that as one line per export.
 *
 * The line carries the declaration text as emitted, not a printed type, so
 * overloads, generics, and modifiers survive into the report and into its
 * diff. Nothing here reads or writes the repository: `generate-api-report.mjs`
 * owns the command, and this module owns the surface.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const ts = createRequire(import.meta.url)("typescript");

export const REGENERATE_HINT = "Regenerate with `npm run api-report`.";
export const MISSING_DIST_HINT = "run npm run typecheck first";
const DIFF_LINE_LIMIT = 60;
const DIFF_CONTEXT = 2;
const DIFF_CELL_LIMIT = 4_000_000;

/** Preference order for reading a declaration file out of one export entry. */
const TYPE_CONDITIONS = ["types", "import", "node", "default", "require"];

const COMPILER_OPTIONS = {
  allowJs: false,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  skipDefaultLibCheck: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  types: [],
};

/** A condition this command can explain to the caller, not a bug in it. */
export class ReportError extends Error {}

/** Byte order, so a report is the same on every machine. */
export function compareStrings(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function toDeclarationFile(target) {
  if (target.endsWith(".d.ts")) return target;
  if (target.endsWith(".mjs")) return `${target.slice(0, -4)}.d.mts`;
  if (target.endsWith(".cjs")) return `${target.slice(0, -4)}.d.cts`;
  if (target.endsWith(".js")) return `${target.slice(0, -3)}.d.ts`;
  return target;
}

function selectDeclarationTarget(value) {
  if (typeof value === "string") return toDeclarationFile(value);
  if (value === null || typeof value !== "object") return undefined;
  for (const condition of TYPE_CONDITIONS) {
    if (!(condition in value)) continue;
    const nested = selectDeclarationTarget(value[condition]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Every entry point a consumer can import, as `{ subpath, specifier, target }`
 * where `target` is the package-relative declaration file. A wildcard subpath
 * names a pattern rather than one surface, so it is skipped.
 */
export function resolveEntryPoints(manifest) {
  const field = manifest.exports;
  const isMap = field !== null && typeof field === "object";
  const subpaths = isMap
    ? Object.entries(field).filter(([key]) => key.startsWith("."))
    : [];

  let entries;
  if (typeof field === "string") entries = [[".", field]];
  else if (subpaths.length > 0)
    entries = subpaths.filter(([key]) => !key.includes("*"));
  else if (isMap) entries = [[".", field]];
  else entries = [[".", manifest.types ?? manifest.typings ?? manifest.main]];

  return entries
    .map(([subpath, value]) => ({
      subpath,
      specifier: `${manifest.name}${subpath.slice(1)}`,
      target: selectDeclarationTarget(value),
    }))
    .filter((entry) => entry.target !== undefined)
    .sort((left, right) => compareStrings(left.subpath, right.subpath));
}

// ---------------------------------------------------------------------------
// Reading the emitted surface
// ---------------------------------------------------------------------------

function describeKind(declaration) {
  switch (declaration.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
      return "function";
    case ts.SyntaxKind.ClassDeclaration:
      return "class";
    case ts.SyntaxKind.InterfaceDeclaration:
      return "interface";
    case ts.SyntaxKind.TypeAliasDeclaration:
      return "type";
    case ts.SyntaxKind.EnumDeclaration:
      return "enum";
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.SourceFile:
      return "namespace";
    default:
      return "const";
  }
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A union's members in byte order, joined back together.
 *
 * TypeScript prints the members of a union in the order it created the type,
 * which is a property of the build rather than of the surface: a fresh `tsc -b`
 * and an incremental one can emit `"blocked" | "no-op" | "ready"` and
 * `"no-op" | "ready" | "blocked"` for the same alias. A report that copied the
 * emitted order would fail `--check` on a line nobody wrote, so every union is
 * put in one order before it reaches the report.
 *
 * The rewrite is driven by the parsed nodes and their source ranges, never by a
 * pattern over the finished line: only the parser can tell a union apart from a
 * `|` inside a string literal, a template literal type, or an overload's body.
 */
function sortedUnionText(union, sourceFile) {
  const members = union.types.map((member) =>
    canonicalNodeText(member, sourceFile),
  );
  return [...members].sort(compareStrings).join(" | ");
}

/** One node's source text, on one line, with every union inside it sorted. */
function canonicalNodeText(node, sourceFile) {
  if (ts.isUnionTypeNode(node)) return sortedUnionText(node, sourceFile);
  const source = sourceFile.text;
  const pieces = [];
  let cursor = node.getStart(sourceFile);
  const visit = (child) => {
    if (ts.isUnionTypeNode(child)) {
      pieces.push(source.slice(cursor, child.getStart(sourceFile)));
      pieces.push(sortedUnionText(child, sourceFile));
      cursor = child.getEnd();
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  pieces.push(source.slice(cursor, node.getEnd()));
  return collapseWhitespace(pieces.join(""));
}

/**
 * The declaration exactly as emitted, on one line, with union members in a
 * fixed order. A variable declaration is widened to its statement so the report
 * keeps `declare const`.
 */
function declarationText(declaration) {
  if (ts.isSourceFile(declaration)) {
    return `(module ${basename(declaration.fileName)})`;
  }
  const statement = declaration.parent?.parent;
  const node =
    ts.isVariableDeclaration(declaration) && statement !== undefined
      ? statement
      : declaration;
  try {
    return canonicalNodeText(node, node.getSourceFile());
  } catch {
    return "(no source text)";
  }
}

function resolveAlias(checker, symbol) {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function compareDeclarations(left, right) {
  const byFile = compareStrings(
    left.getSourceFile().fileName,
    right.getSourceFile().fileName,
  );
  return byFile === 0 ? left.pos - right.pos : byFile;
}

function describeExport(checker, symbol) {
  const name = symbol.getName();
  const resolved = resolveAlias(checker, symbol);
  const declarations = [...(resolved.getDeclarations() ?? [])].sort(
    compareDeclarations,
  );
  if (declarations.length === 0) {
    return { kind: "const", name, signature: "(no declaration)" };
  }
  const signatures = [];
  for (const declaration of declarations) {
    const text = declarationText(declaration);
    if (!signatures.includes(text)) signatures.push(text);
  }
  return {
    kind: describeKind(declarations[0]),
    name,
    signature: signatures.join(" "),
  };
}

/** Every export of one module, sorted by name. */
export function collectExports(checker, sourceFile) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => describeExport(checker, symbol))
    .sort((left, right) => compareStrings(left.name, right.name));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A fence long enough that no export line can close it early. */
function fenceFor(body) {
  let longest = 0;
  for (const line of body) {
    for (const run of line.match(/`+/g) ?? []) {
      longest = Math.max(longest, run.length);
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The report text. Export lines live inside a fence so that Prettier and the
 * markdown link check leave the emitted declarations exactly as they are.
 */
export function renderReport({ name, published, sections }) {
  const lines = [
    `# API report: ${name}`,
    "",
    `Published: ${published ? "yes" : "no"}`,
    "",
    REGENERATE_HINT,
    "",
  ];
  for (const section of sections) {
    const body =
      section.exports.length === 0
        ? ["(no exports)"]
        : section.exports.map(
            (entry) => `- ${entry.kind} ${entry.name}: ${entry.signature}`,
          );
    const fence = fenceFor(body);
    lines.push(
      `Entry point: ${section.specifier}`,
      "",
      fence,
      ...body,
      fence,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function findSourceFile(program, path) {
  const direct = program.getSourceFile(path);
  if (direct !== undefined) return direct;
  const wanted = path.split("\\").join("/");
  return program
    .getSourceFiles()
    .find((file) => file.fileName.split("\\").join("/") === wanted);
}

/** The report text for one package, read from its emitted declarations. */
export function buildReport(packageEntry, published) {
  const entryPoints = resolveEntryPoints(packageEntry.manifest);
  if (entryPoints.length === 0) {
    throw new ReportError(`${packageEntry.name}: no entry point is declared.`);
  }
  const rootFiles = entryPoints.map((entry) =>
    join(packageEntry.directory, entry.target),
  );
  const missing = entryPoints.filter(
    (entry, index) => !existsSync(rootFiles[index]),
  );
  if (missing.length > 0) {
    const names = missing.map((entry) => entry.target).join(", ");
    throw new ReportError(
      `${packageEntry.name}: ${names} is missing — ${MISSING_DIST_HINT}.`,
    );
  }

  const program = ts.createProgram(rootFiles, COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const sections = entryPoints.map((entry, index) => {
    const sourceFile = findSourceFile(program, rootFiles[index]);
    if (sourceFile === undefined) {
      throw new ReportError(
        `${packageEntry.name}: ${entry.target} could not be read — ` +
          `${MISSING_DIST_HINT}.`,
      );
    }
    return {
      specifier: entry.specifier,
      exports: collectExports(checker, sourceFile),
    };
  });

  return {
    sections,
    text: renderReport({ name: packageEntry.name, published, sections }),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

function splitLines(text) {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

function diffOperations(before, after) {
  if (before.length * after.length > DIFF_CELL_LIMIT) {
    return [
      ...before.map((text) => ({ sign: "-", text })),
      ...after.map((text) => ({ sign: "+", text })),
    ];
  }
  const columns = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * columns);
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] =
        before[row] === after[column]
          ? lengths[(row + 1) * columns + column + 1] + 1
          : Math.max(
              lengths[(row + 1) * columns + column],
              lengths[row * columns + column + 1],
            );
    }
  }

  const operations = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      operations.push({ sign: " ", text: before[row] });
      row += 1;
      column += 1;
    } else if (
      lengths[(row + 1) * columns + column] >=
      lengths[row * columns + column + 1]
    ) {
      operations.push({ sign: "-", text: before[row] });
      row += 1;
    } else {
      operations.push({ sign: "+", text: after[column] });
      column += 1;
    }
  }
  while (row < before.length) {
    operations.push({ sign: "-", text: before[row] });
    row += 1;
  }
  while (column < after.length) {
    operations.push({ sign: "+", text: after[column] });
    column += 1;
  }
  return operations;
}

/**
 * A unified diff of two report texts: changed lines with a little context,
 * capped so one drifted package cannot bury the rest of the run.
 */
export function diffLines(before, after, limit = DIFF_LINE_LIMIT) {
  const operations = diffOperations(splitLines(before), splitLines(after));
  const keep = new Array(operations.length).fill(false);
  operations.forEach((operation, index) => {
    if (operation.sign === " ") return;
    const first = Math.max(0, index - DIFF_CONTEXT);
    const last = Math.min(operations.length - 1, index + DIFF_CONTEXT);
    for (let cursor = first; cursor <= last; cursor += 1) keep[cursor] = true;
  });

  const lines = [];
  let skipping = false;
  operations.forEach((operation, index) => {
    if (!keep[index]) {
      skipping = true;
      return;
    }
    if (skipping) lines.push("@@");
    skipping = false;
    lines.push(`${operation.sign}${operation.text}`);
  });

  if (lines.length <= limit) return lines;
  return [
    ...lines.slice(0, limit),
    `... ${lines.length - limit} more diff lines`,
  ];
}
