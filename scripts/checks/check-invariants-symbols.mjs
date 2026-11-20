import ts from "typescript";

/**
 * What a cited file declares, and what it names as a test.
 *
 * Names come from the TypeScript parser, never from a pattern over the text: a
 * regular expression cannot tell a top-level `function resolveAccess(` from
 * one nested inside another function, from a property of that name, or from
 * the word inside a comment. The same API reads `.mjs` and `.js`.
 *
 * A declaration is any name the file introduces, exported or not and at any
 * depth, plus the members of a class, an interface, and a type literal. Depth
 * matters because the packages cite what they enforce: `http-client.ts#safe`
 * and `route-access.ts#require` are functions declared inside the factory that
 * returns them, and they are the code the invariant is about. The members are
 * what `Class#method`, `Class.method`, and the bare `tag` in "`RouteDefinition`
 * requiring `tag`" cite.
 *
 * Rust is read by line, because nothing in this repository needs a Rust parser
 * to answer "does this file declare `run_plan`". A Rust proof citation is a
 * `path#fn` like every other Rust citation, so a test function resolves
 * through the same declaration set as the code it proves.
 */

const TEST_FUNCTIONS = new Set(["it", "test", "describe"]);
const SCRIPT_KINDS = new Map([
  ["ts", ts.ScriptKind.TS],
  ["mts", ts.ScriptKind.TS],
  ["cts", ts.ScriptKind.TS],
  ["tsx", ts.ScriptKind.TSX],
  ["js", ts.ScriptKind.JS],
  ["mjs", ts.ScriptKind.JS],
  ["cjs", ts.ScriptKind.JS],
  ["jsx", ts.ScriptKind.JSX],
]);
const RUST_DECLARATION =
  /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+"[^"]*"\s+)*(fn|struct|enum|trait|union|type|const|static|mod|macro_rules!)\s+([A-Za-z_]\w*)/;
const PLACEHOLDER = /%[sdifjo#%]|\$\w+/g;

/** The extension a path ends in, lower-cased, or `""`. */
export function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/** True when a symbol can be looked up in a file of this extension. */
export function carriesSymbols(path) {
  const extension = extensionOf(path);
  return extension === "rs" || SCRIPT_KINDS.has(extension);
}

/** Every name the file declares, including `Owner#member` and bare members. */
export function readDeclaredSymbols(text, path) {
  if (extensionOf(path) === "rs") return readRustDeclarations(text);
  const names = new Set();
  const visit = (node) => {
    collectNode(node, names);
    ts.forEachChild(node, visit);
  };
  visit(parseSource(text, path));
  return names;
}

function readRustDeclarations(text) {
  const names = new Set();
  for (const line of text.split("\n")) {
    const match = RUST_DECLARATION.exec(line);
    if (match !== null) names.add(match[2]);
  }
  return names;
}

function parseSource(text, path) {
  const kind = SCRIPT_KINDS.get(extensionOf(path)) ?? ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const failure = parsed.parseDiagnostics?.[0];
  if (failure !== undefined) {
    throw new Error(
      `${path}: could not be parsed: ${ts.flattenDiagnosticMessageText(failure.messageText, " ")}`,
    );
  }
  return parsed;
}

function collectNode(node, names) {
  if (ts.isVariableDeclaration(node)) {
    collectBinding(node.name, names);
    return;
  }
  if (ts.isExportDeclaration(node) || ts.isImportDeclaration(node)) {
    collectModuleBindings(node, names);
    return;
  }
  if (!isNamedDeclaration(node)) return;
  const owner = node.name;
  if (owner === undefined || !ts.isIdentifier(owner)) return;
  names.add(owner.text);
  collectMembers(node, owner.text, names);
}

function isNamedDeclaration(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

function collectBinding(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements ?? []) {
    if (ts.isBindingElement(element)) collectBinding(element.name, names);
  }
}

/**
 * The names an `import` or `export` clause binds. An import binding is a name
 * this file introduces, so `create-dads.ts#initializeDadsProject` resolves in
 * the file that calls it — which is the file the entry means, and the file a
 * removal of the import would break.
 */
function collectModuleBindings(statement, names) {
  const clause = statement.importClause ?? statement.exportClause;
  if (clause === undefined) return;
  if (clause.name !== undefined) names.add(clause.name.text);
  const bindings = ts.isImportClause(clause) ? clause.namedBindings : clause;
  if (bindings === undefined) return;
  if (ts.isNamespaceImport(bindings)) {
    names.add(bindings.name.text);
    return;
  }
  if (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) return;
  for (const specifier of bindings.elements) names.add(specifier.name.text);
}

/** Class, interface, and type-literal members, as `Owner#member` and bare. */
function collectMembers(statement, owner, names) {
  const members = ts.isTypeAliasDeclaration(statement)
    ? memberNodesOfType(statement.type)
    : (statement.members ?? []);
  for (const member of members) {
    const name = memberNameOf(member);
    if (name === undefined) continue;
    names.add(`${owner}#${name}`);
    names.add(name);
  }
}

/** A member's name, with a `#private` field read as the name it is cited by. */
function memberNameOf(member) {
  const name = member.name;
  if (name === undefined) return undefined;
  if (ts.isPrivateIdentifier(name)) return name.text.replace(/^#/, "");
  return ts.isIdentifier(name) ? name.text : undefined;
}

function memberNodesOfType(type) {
  if (type === undefined) return [];
  if (ts.isTypeLiteralNode(type)) return type.members;
  if (ts.isIntersectionTypeNode(type)) {
    return type.types.flatMap((member) => memberNodesOfType(member));
  }
  return [];
}

/** True when `symbol` is declared, with `A.b` and `A#b` read as one name. */
export function declaresSymbol(names, symbol) {
  return names.has(symbol) || names.has(symbol.replace(".", "#"));
}

/**
 * Every name the file gives a test. A literal name is recorded as written; a
 * template literal and an `it.each` title are recorded as a pattern, where
 * `%s`, `$name`, and `${...}` each stand for any text, so a cited name that
 * the pattern produces resolves.
 */
export function readTestNames(text, path) {
  const literals = new Set();
  const patterns = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      collectTestName(node, literals, patterns);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(text, path));
  return { literals, patterns };
}

function collectTestName(call, literals, patterns) {
  if (!TEST_FUNCTIONS.has(baseIdentifierOf(call.expression))) return;
  const title = call.arguments[0];
  if (title === undefined) return;
  if (ts.isNoSubstitutionTemplateLiteral(title) || ts.isStringLiteral(title)) {
    addTitle(title.text, literals, patterns);
    return;
  }
  if (ts.isTemplateExpression(title)) {
    patterns.push(patternOf(templateShapeOf(title)));
  }
}

/** `it`, from `it`, `it.each([...])`, `describe.skipIf(x)`, and so on. */
function baseIdentifierOf(expression) {
  let node = expression;
  while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node.text : "";
}

function addTitle(title, literals, patterns) {
  literals.add(title);
  PLACEHOLDER.lastIndex = 0;
  if (PLACEHOLDER.test(title)) patterns.push(patternOf(title));
}

/** A template expression flattened to its literal text with `%s` for holes. */
function templateShapeOf(title) {
  const spans = title.templateSpans.map((span) => `%s${span.literal.text}`);
  return `${title.head.text}${spans.join("")}`;
}

function patternOf(shape) {
  const escaped = shape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/%[sdifjo#%]|\\\$\w+/g, ".+");
  return new RegExp(`^${body}$`);
}

/** True when a test of that exact name, or of a matching title, exists. */
export function namesTest(tests, name) {
  if (tests.literals.has(name)) return true;
  return tests.patterns.some((pattern) => pattern.test(name));
}
