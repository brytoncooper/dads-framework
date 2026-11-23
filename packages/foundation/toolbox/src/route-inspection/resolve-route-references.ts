import { posix } from "node:path";
import ts from "typescript";
import { readProperty, readRouteSchemas, type RouteSchemas } from "./route-source-facts.js";

const OPERATION_BUILDERS = new Map<string, string | undefined>([
  ["getOperation", "GET"],
  ["listOperation", "GET"],
  ["postOperation", "POST"],
  ["patchOperation", "PATCH"],
  ["putOperation", "PUT"],
  ["deleteOperation", "DELETE"],
  ["defineOperation", undefined],
]);

const EXTENSION_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".js"],
  ".jsx": [".tsx", ".ts", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

const BARE_CANDIDATES = [".ts", ".tsx", ".mts", ".cts", ".js", "/index.ts", "/index.tsx", "/index.js"] as const;

export type RouteFileReader = (filePath: string) => string | undefined;

export type ResolvedOperationFacts = {
  readonly method?: string;
  readonly routePath?: string;
  readonly schemas: RouteSchemas;
};

export type ResolvedRouteDescriptor = {
  readonly method?: string;
  readonly routePath?: string;
};

type ResolvedBinding = {
  readonly node: ts.Expression;
  readonly source: ts.SourceFile;
  readonly file: string;
};

export type RouteReferenceResolver = {
  resolveString(node: ts.Node | undefined): string | undefined;
  resolveDescriptor(node: ts.Node | undefined): ResolvedRouteDescriptor | undefined;
  resolveOperation(node: ts.Node | undefined): ResolvedOperationFacts | undefined;
};

/** Resolves same-file and relative-imported route constants, descriptors, and `*Operation` contracts. */
export function createRouteReferenceResolver(
  entrySource: ts.SourceFile,
  entryFile: string,
  readFile?: RouteFileReader,
): RouteReferenceResolver {
  const entryPath = normalizePosix(entryFile);
  const parsedFiles = new Map<string, ts.SourceFile>([[entryPath, entrySource]]);

  function loadRelativeModule(
    fromFile: string,
    specifier: string,
  ): { source: ts.SourceFile; file: string } | undefined {
    if (readFile === undefined || (!specifier.startsWith("./") && !specifier.startsWith("../"))) {
      return undefined;
    }
    const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    for (const candidate of candidateModulePaths(base)) {
      const cached = parsedFiles.get(candidate);
      if (cached !== undefined) return { source: cached, file: candidate };
      const text = readFile(candidate);
      if (text === undefined) continue;
      const source = ts.createSourceFile(candidate, text, ts.ScriptTarget.Latest, true);
      parsedFiles.set(candidate, source);
      return { source, file: candidate };
    }
    return undefined;
  }

  function resolveLocalInitializer(source: ts.SourceFile, name: string): ts.Expression | undefined {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer !== undefined
        ) {
          return declaration.initializer;
        }
      }
    }
    return undefined;
  }

  function resolveExportedBinding(
    name: string,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): ResolvedBinding | undefined {
    const key = `${file}#${name}`;
    if (visited.has(key)) return undefined;
    visited.add(key);

    const local = resolveLocalInitializer(source, name);
    if (local !== undefined) return { node: local, source, file };

    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const resolved = resolveFromExportDeclaration(statement, name, source, file, visited);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }

  function resolveNamedExport(
    clause: ts.NamedExports,
    specifier: string | undefined,
    name: string,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): ResolvedBinding | undefined {
    const element = clause.elements.find((candidate) => !candidate.isTypeOnly && candidate.name.text === name);
    if (element === undefined) return undefined;
    const targetName = (element.propertyName ?? element.name).text;
    if (specifier === undefined) return resolveIdentifierBinding(targetName, source, file, visited);
    const target = loadRelativeModule(file, specifier);
    return target ? resolveExportedBinding(targetName, target.source, target.file, visited) : undefined;
  }

  function resolveFromExportDeclaration(
    statement: ts.ExportDeclaration,
    name: string,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): ResolvedBinding | undefined {
    const specifier =
      statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      return resolveNamedExport(statement.exportClause, specifier, name, source, file, visited);
    }
    if (statement.exportClause !== undefined || specifier === undefined) return undefined;
    const target = loadRelativeModule(file, specifier);
    return target ? resolveExportedBinding(name, target.source, target.file, visited) : undefined;
  }

  function matchNamedImportIn(
    statement: ts.Statement,
    name: string,
  ): { readonly specifier: string; readonly exportedName: string } | undefined {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return undefined;
    if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return undefined;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return undefined;
    const match = bindings.elements.find((element) => !element.isTypeOnly && element.name.text === name);
    if (match === undefined) return undefined;
    return { specifier: statement.moduleSpecifier.text, exportedName: (match.propertyName ?? match.name).text };
  }

  function findNamedImport(
    source: ts.SourceFile,
    name: string,
  ): { readonly specifier: string; readonly exportedName: string } | undefined {
    for (const statement of source.statements) {
      const found = matchNamedImportIn(statement, name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function resolveIdentifierBinding(
    name: string,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): ResolvedBinding | undefined {
    const local = resolveLocalInitializer(source, name);
    if (local !== undefined) return { node: local, source, file };
    const imported = findNamedImport(source, name);
    if (imported === undefined) return undefined;
    const target = loadRelativeModule(file, imported.specifier);
    return target ? resolveExportedBinding(imported.exportedName, target.source, target.file, visited) : undefined;
  }

  function resolveTemplateString(
    target: ts.TemplateExpression,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): string | undefined {
    let text = target.head.text;
    for (const span of target.templateSpans) {
      const piece = resolveStringIn(span.expression, source, file, visited);
      if (piece === undefined) return undefined;
      text += piece + span.literal.text;
    }
    return text;
  }

  function resolveIdentifierString(
    target: ts.Identifier,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): string | undefined {
    const key = `str:${file}#${target.text}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const bound = resolveIdentifierBinding(target.text, source, file, visited);
    return bound ? resolveStringIn(bound.node, bound.source, bound.file, visited) : undefined;
  }

  function resolveStringIn(
    node: ts.Node | undefined,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): string | undefined {
    const target = unwrapExpression(node);
    if (target === undefined) return undefined;
    if (ts.isStringLiteralLike(target)) return target.text;
    if (ts.isTemplateExpression(target)) return resolveTemplateString(target, source, file, visited);
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveStringIn(target.left, source, file, visited);
      const right = resolveStringIn(target.right, source, file, visited);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    return ts.isIdentifier(target) ? resolveIdentifierString(target, source, file, visited) : undefined;
  }

  function buildDescriptor(method: string | undefined, routePath: string | undefined): ResolvedRouteDescriptor {
    return {
      ...(method !== undefined ? { method } : {}),
      ...(routePath !== undefined ? { routePath } : {}),
    };
  }

  function resolveDescriptorIn(
    node: ts.Node | undefined,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): ResolvedRouteDescriptor | undefined {
    const target = unwrapExpression(node);
    if (target === undefined) return undefined;
    if (ts.isObjectLiteralExpression(target)) {
      const method = resolveStringIn(readProperty(target, "method"), source, file, visited);
      const pathNode = readProperty(target, "template") ?? readProperty(target, "path");
      return buildDescriptor(method, resolveStringIn(pathNode, source, file, visited));
    }
    if (ts.isCallExpression(target) && routeCalleeName(target.expression) === "defineRoute") {
      const method = resolveStringIn(target.arguments[0], source, file, visited);
      const routePath = resolveStringIn(target.arguments[1], source, file, visited);
      return buildDescriptor(method, routePath);
    }
    if (!ts.isIdentifier(target)) return undefined;
    const bound = resolveIdentifierBinding(target.text, source, file, visited);
    return bound ? resolveDescriptorIn(bound.node, bound.source, bound.file, visited) : undefined;
  }

  function extractOperationConfig(
    config: ts.ObjectLiteralExpression,
    builderName: string,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): ResolvedOperationFacts {
    const descriptor = resolveDescriptorIn(readProperty(config, "route"), source, file, visited);
    const method =
      descriptor?.method ??
      resolveStringIn(readProperty(config, "method"), source, file, visited) ??
      OPERATION_BUILDERS.get(builderName);
    const pathNode = readProperty(config, "path") ?? readProperty(config, "template");
    const routePath = descriptor?.routePath ?? resolveStringIn(pathNode, source, file, visited);
    return {
      ...buildDescriptor(method, routePath),
      schemas: readRouteSchemas(config, source),
    };
  }

  function resolveOperationIn(
    node: ts.Node | undefined,
    source: ts.SourceFile,
    file: string,
    visited: Set<string>,
  ): ResolvedOperationFacts | undefined {
    const target = unwrapExpression(node);
    if (target === undefined) return undefined;
    if (ts.isIdentifier(target)) {
      const bound = resolveIdentifierBinding(target.text, source, file, visited);
      return bound ? resolveOperationIn(bound.node, bound.source, bound.file, visited) : undefined;
    }
    if (!ts.isCallExpression(target)) return undefined;
    const name = routeCalleeName(target.expression);
    if (name === undefined || !OPERATION_BUILDERS.has(name)) return undefined;
    const config = unwrapExpression(target.arguments[0]);
    if (config === undefined || !ts.isObjectLiteralExpression(config)) return undefined;
    return extractOperationConfig(config, name, source, file, visited);
  }

  return {
    resolveString: (node) => resolveStringIn(node, entrySource, entryPath, new Set()),
    resolveDescriptor: (node) => resolveDescriptorIn(node, entrySource, entryPath, new Set()),
    resolveOperation: (node) => resolveOperationIn(node, entrySource, entryPath, new Set()),
  };
}

function unwrapExpression(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current !== undefined) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return undefined;
}

function routeCalleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function normalizePosix(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function candidateModulePaths(base: string): readonly string[] {
  const extension = posix.extname(base);
  const replacements = EXTENSION_CANDIDATES[extension];
  if (replacements !== undefined) {
    const stem = base.slice(0, -extension.length);
    return replacements.map((next) => `${stem}${next}`);
  }
  if (extension.length > 0) return [base];
  return BARE_CANDIDATES.map((suffix) => `${base}${suffix}`);
}
