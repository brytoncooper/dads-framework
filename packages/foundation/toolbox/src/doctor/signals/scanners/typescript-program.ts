/**
 * The TypeScript program: every module the workspace declares, parsed once.
 *
 * Phase zero answered its TypeScript questions from a hand-written skeleton of
 * the source and said so — a skeleton cannot tell an `as` in a template
 * literal from an `as` in an expression, and it cannot count a function's
 * branches at all. This module is the thing that replaces it: the compiler's
 * own parser, run once over the workspace, so every reading below is taken
 * from syntax rather than from a pattern over text. A signal that reads a
 * quotation of a hatch therefore no longer counts it, which is why this
 * package can diagnose the hatches it also has to name.
 *
 * **What "the program" is here.** It is the parsed modules, not a type
 * checker. Every question the catalog's TypeScript signals ask is answered by
 * syntax: an `any` annotation, an `as`, a function's branch count, an import
 * edge, a field-name set, a doc comment. Building a checked program instead
 * would mean resolving every dependency in `node_modules` on every run, which
 * costs minutes and gigabytes on a large workspace, is only as deterministic
 * as the installed tree, and would put a report-by-default command behind an
 * install. When a signal is added that genuinely needs a checker, it is the
 * checker that gets built lazily beside this, not this that grows one.
 *
 * **What it reads.** The workspace's `tsconfig.json` files say which
 * directories are TypeScript projects; the context's file list says which
 * files somebody wrote. A module is a hand-written `.ts` or `.tsx` under a
 * project directory. Declaration files and generated modules are excluded
 * because nobody typed them. A workspace with no `tsconfig.json` has no
 * program, and this throws with that as the reason so every signal that reads
 * one reports `not measured` rather than a confident zero.
 *
 * **The vendor stops here.** `typescript` is imported by this module and no
 * other, and re-exported from it, so the compiler API enters the doctor
 * through one file. That is the same rule `the paper wall` states, applied to
 * the code that measures it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type {
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { isTestSource } from "./source-classification.js";

/** The compiler API. Every signal that needs it takes it from here. */
export { ts };

const CONFIG_FILE = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/;
const MODULE_SUFFIXES = [".ts", ".tsx"];
const DECLARATION_SUFFIX = ".d.ts";
const GENERATED_SUFFIX = ".generated.ts";
const SOURCE_MARKER = "/src/";
const NON_PRODUCTION_SEGMENTS = [
  "/type-tests/",
  "/test-support/",
  "/__tests__/",
  "/src/testing/",
];
const NON_PRODUCTION_ROOTS = ["scripts/", "fixtures/", "tools/"];
const NO_PROGRAM = "no tsconfig.json in this workspace";
const DOC_COMMENT_HEAD = "/**";

/** One parsed module, and the package that owns it. */
export type DoctorModule = {
  /** Repository-relative path, which is also the parsed file's name. */
  readonly path: string;
  /** The declared package root that owns it, or its directory. */
  readonly packageRoot: string;
  readonly source: ts.SourceFile;
};

export type DoctorProgram = {
  /** Every module, in the order the file list gave them. */
  readonly modules: readonly DoctorModule[];
  /** The module at a repository-relative path, when one was parsed. */
  module(path: string): DoctorModule | undefined;
};

/**
 * What building a program needs from the context. It is written as its own
 * type rather than as `DoctorContext` so the context can depend on this module
 * and not the other way round.
 */
export type ProgramWorkspace = {
  readonly root: string;
  files(): readonly string[];
  packages(): readonly { readonly root: string }[];
};

/** Parses every module the workspace declares. Throws when it declares none. */
export function buildTypeScriptProgram(
  workspace: ProgramWorkspace,
): DoctorProgram {
  const files = workspace.files();
  const projects = projectDirectories(files);
  if (projects.length === 0) throw new Error(NO_PROGRAM);
  const owners = declaredRoots(workspace.packages());
  const modules: DoctorModule[] = [];
  const found = new Map<string, DoctorModule>();
  for (const path of files) {
    if (!isModulePath(path)) continue;
    if (!projects.some((directory) => path.startsWith(directory))) continue;
    const parsed = parseModule(workspace.root, path, owners);
    modules.push(parsed);
    found.set(path, parsed);
  }
  return { modules, module: (path) => found.get(path) };
}

/**
 * True for a file that declares a TypeScript project. The gate asks, because a
 * run narrowed to one path still has to know where the projects are: a file
 * list with no `tsconfig.json` in it is a workspace with no program.
 */
export function isTypeScriptProjectFile(path: string): boolean {
  return CONFIG_FILE.test(path);
}

/** The directory of every `tsconfig`, as a path prefix; `""` is the root. */
function projectDirectories(files: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const path of files) {
    if (!isTypeScriptProjectFile(path)) continue;
    const cut = path.lastIndexOf("/");
    directories.add(cut === -1 ? "" : path.slice(0, cut + 1));
  }
  return [...directories];
}

function declaredRoots(
  packages: readonly { readonly root: string }[],
): readonly string[] {
  return packages
    .map((declared) => declared.root)
    .filter((root) => root.length > 0)
    .sort((left, right) => right.length - left.length);
}

function isModulePath(path: string): boolean {
  if (path.endsWith(DECLARATION_SUFFIX)) return false;
  if (path.endsWith(GENERATED_SUFFIX)) return false;
  return MODULE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function parseModule(
  root: string,
  path: string,
  owners: readonly string[],
): DoctorModule {
  const text = readFileSync(join(root, path), "utf8");
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return { path, packageRoot: owningPackageRoot(path, owners), source };
}

/**
 * The declared package that owns a module, the directory above its `src/` when
 * nothing is declared, and its own directory otherwise. A repository that has
 * not adopted Dads still groups its modules by something a reader recognises.
 */
function owningPackageRoot(path: string, owners: readonly string[]): string {
  const declared = owners.find((root) => path.startsWith(`${root}/`));
  if (declared !== undefined) return declared;
  const marker = path.indexOf(SOURCE_MARKER);
  if (marker !== -1) return path.slice(0, marker);
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

// ---------------------------------------------------------------------------
// Reading a parsed module
// ---------------------------------------------------------------------------

/** Every node below `node`, in source order. */
export function visitNodes(
  node: ts.Node,
  visit: (node: ts.Node) => void,
): void {
  node.forEachChild((child) => {
    visit(child);
    visitNodes(child, visit);
  });
}

/** The 1-based line a node starts on. */
export function lineOf(module: DoctorModule, node: ts.Node): number {
  const start = node.getStart(module.source);
  return module.source.getLineAndCharacterOfPosition(start).line + 1;
}

/** Evidence a reader can open: the file, the line, and what was found there. */
export function evidenceAt(
  module: DoctorModule,
  node: ts.Node,
  name?: string,
): SignalEvidence {
  const line = lineOf(module, node);
  return name === undefined
    ? { path: module.path, line }
    : { path: module.path, line, name };
}

/** True for the hand-written TypeScript a package ships to its consumers. */
export function isProductionModule(path: string): boolean {
  if (isTestSource(path)) return false;
  if (NON_PRODUCTION_ROOTS.some((root) => path.startsWith(root))) return false;
  return !NON_PRODUCTION_SEGMENTS.some((segment) => path.includes(segment));
}

/** True when a doc-comment block sits immediately above the node. */
export function hasDocComment(module: DoctorModule, node: ts.Node): boolean {
  const text = module.source.text;
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return ranges.some(
    (range) => text.slice(range.pos, range.pos + 3) === DOC_COMMENT_HEAD,
  );
}

/** True when a statement carries the modifier named. */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((modifier) => modifier.kind === kind);
}

/** The top-level statements a module exports. */
export function exportedStatements(
  module: DoctorModule,
): readonly ts.Statement[] {
  return module.source.statements.filter((statement) =>
    hasModifier(statement, ts.SyntaxKind.ExportKeyword),
  );
}

/** The names a top-level statement declares, which is none for most of them. */
export function declaredNames(statement: ts.Statement): readonly string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declared) =>
      ts.isIdentifier(declared.name) ? [declared.name.text] : [],
    );
  }
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  if (
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return [statement.name.text];
  }
  return [];
}

/**
 * True for an assertion that widens what the compiler knew: `value as Thing`
 * and the older `<Thing>value`. `as const` is not one of them — it narrows a
 * literal to itself and revokes nothing — and neither is `satisfies`, which
 * checks rather than asserts. Two signals ask this question, of production
 * source and of tests, so the answer is decided here once.
 */
export function isWideningAssertion(node: ts.Node): boolean {
  if (ts.isTypeAssertionExpression(node)) return true;
  if (!ts.isAsExpression(node)) return false;
  return !isConstType(node.type);
}

function isConstType(type: ts.TypeNode): boolean {
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "const"
  );
}

// ---------------------------------------------------------------------------
// Counting occurrences
// ---------------------------------------------------------------------------

/**
 * What a per-module count needs: which modules to read, what an occurrence
 * looks like, and what to write on the evidence line so a reader knows what
 * they are being sent to look at.
 */
export type OccurrenceCount = {
  readonly program: DoctorProgram;
  readonly include: (path: string) => boolean;
  readonly match: (node: ts.Node) => boolean;
  readonly name: string;
};

/**
 * One key per module read, counting the nodes that match — including the
 * modules that match nothing.
 *
 * A signal with a threshold reports every subject it examined, so its line
 * reads "0 of 592 over" rather than "not measured": a clean repository is not
 * an unmeasured one, and the difference is the whole value of running this
 * twice.
 *
 * A signal that is report-only in `standard` does the opposite and emits only
 * what it has something to say about. The report counts any non-zero reading
 * of a report-only signal as something seen, so a distribution of healthy
 * numbers would report every repository as partially ill; the subjects a
 * report-only signal emits are therefore the ones at or over the ceiling
 * `strict` would apply.
 */
export function countOccurrences(options: OccurrenceCount): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of options.program.modules) {
    if (!options.include(module.path)) continue;
    const evidence: SignalEvidence[] = [];
    visitNodes(module.source, (node) => {
      if (options.match(node)) {
        evidence.push(evidenceAt(module, node, options.name));
      }
    });
    readings.set(module.path, { value: evidence.length, evidence });
  }
  return readings;
}

/** True for anything that runs a body of its own. */
export function isFunctionNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function blockOf(body: ts.Node | undefined): ts.Block | undefined {
  return body !== undefined && ts.isBlock(body) ? body : undefined;
}

/** The block a function runs, or nothing for a signature or a short arrow. */
export function functionBodyOf(node: ts.Node): ts.Block | undefined {
  if (ts.isFunctionDeclaration(node)) return blockOf(node.body);
  if (ts.isMethodDeclaration(node)) return blockOf(node.body);
  if (ts.isFunctionExpression(node)) return blockOf(node.body);
  if (ts.isArrowFunction(node)) return blockOf(node.body);
  if (ts.isConstructorDeclaration(node)) return blockOf(node.body);
  if (ts.isGetAccessorDeclaration(node)) return blockOf(node.body);
  if (ts.isSetAccessorDeclaration(node)) return blockOf(node.body);
  return undefined;
}

/** The name a function-like node carries, for an evidence line. */
export function functionName(node: ts.Node): string {
  if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) {
    return "anonymous function";
  }
  return node.name !== undefined && ts.isIdentifier(node.name)
    ? node.name.text
    : "anonymous function";
}

/** The leftmost identifier of a type name, which is the one that was imported. */
export function leftmostTypeName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmostTypeName(name.left);
}

/** True when the node or anything below it matches. */
export function containsNode(
  node: ts.Node,
  match: (node: ts.Node) => boolean,
): boolean {
  let found = match(node);
  visitNodes(node, (child) => {
    if (match(child)) found = true;
  });
  return found;
}

/**
 * True when the node or anything below it matches, without entering a function
 * declared inside it. What a callback does happens later and somewhere else,
 * so a question about "this expression" must stop where the next scope starts.
 */
export function containsInScope(
  node: ts.Node,
  match: (node: ts.Node) => boolean,
): boolean {
  if (match(node)) return true;
  let found = false;
  node.forEachChild((child) => {
    if (isFunctionNode(child)) return;
    if (containsInScope(child, match)) found = true;
  });
  return found;
}

/** Adds one finding to the running count for a key. */
export function addFinding(
  readings: Map<string, SignalReading>,
  key: string,
  evidence: SignalEvidence,
): void {
  const found = readings.get(key);
  readings.set(key, {
    value: (found?.value ?? 0) + 1,
    evidence: [...(found?.evidence ?? []), evidence],
  });
}

// ---------------------------------------------------------------------------
// The import graph
// ---------------------------------------------------------------------------

/**
 * One module specifier and the node that names it, with the two distinctions
 * every reader of the graph needs: an edge the compiler erases, and an edge
 * that is a surface listing rather than something the module uses.
 */
export type ModuleImport = {
  readonly specifier: string;
  readonly node: ts.Node;
  /** True for `import type`, which leaves nothing behind at runtime. */
  readonly typeOnly: boolean;
  /** True for `export … from`, which republishes rather than consumes. */
  readonly reExport: boolean;
};

/** Every specifier a module names: `import`, `export … from`, `import("…")`. */
export function moduleImports(module: DoctorModule): readonly ModuleImport[] {
  const found: ModuleImport[] = [];
  const collect = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    if (specifier === undefined) return;
    found.push({
      specifier,
      node,
      typeOnly: isTypeOnlyEdge(node),
      reExport: ts.isExportDeclaration(node),
    });
  };
  visitNodes(module.source, collect);
  return found;
}

function specifierOf(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    if (specifier !== undefined && ts.isStringLiteral(specifier)) {
      return specifier.text;
    }
    return undefined;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    const literal = node.argument.literal;
    return ts.isStringLiteral(literal) ? literal.text : undefined;
  }
  return undefined;
}

/** True when nothing of this edge survives compilation. */
function isTypeOnlyEdge(node: ts.Node): boolean {
  if (ts.isImportTypeNode(node)) return true;
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  if (clause.name !== undefined) return false;
  const bound = clause.namedBindings;
  if (bound === undefined || !ts.isNamedImports(bound)) return false;
  return bound.elements.every((element) => element.isTypeOnly);
}

/** `@scope/name/deep` and `name/deep` both name the package `…/name`. */
export function packageOfSpecifier(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
}

/** True for a relative path or a Node builtin, which name no package. */
export function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("node:");
}

/** Every local name a module imports, mapped to the specifier it came from. */
export function importedBindings(
  module: DoctorModule,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of module.source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    for (const name of importedNames(statement.importClause)) {
      bindings.set(name, from);
    }
  }
  return bindings;
}

function importedNames(clause: ts.ImportClause | undefined): readonly string[] {
  if (clause === undefined) return [];
  const names = clause.name === undefined ? [] : [clause.name.text];
  const bound = clause.namedBindings;
  if (bound === undefined) return names;
  if (ts.isNamespaceImport(bound)) return [...names, bound.name.text];
  return [...names, ...bound.elements.map((element) => element.name.text)];
}

/**
 * The repository-relative paths a relative specifier could name. Node's ESM
 * resolution writes `./thing.js` for a module whose source is `./thing.ts`, so
 * both spellings and the directory barrel are offered and the caller keeps
 * whichever the program actually parsed.
 */
export function resolveRelativeImport(
  fromPath: string,
  specifier: string,
): readonly string[] {
  if (!specifier.startsWith(".")) return [];
  const base = joinRelative(fromPath, specifier);
  const stem = base.replace(/\.(?:js|mjs|cjs|ts|tsx)$/, "");
  return [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`];
}

function joinRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part.length === 0) continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}
