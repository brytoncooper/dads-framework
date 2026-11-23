import ts from "typescript";
import {
  readRouteHandler,
  declaresResourceFreeTelemetry,
  readRouteSchemas,
  readProperty,
  readText,
} from "./route-source-facts.js";

const builders = new Map([
  ["get", "GET"],
  ["list", "GET"],
  ["post", "POST"],
  ["patch", "PATCH"],
  ["put", "PUT"],
  ["delete", "DELETE"],
]);

export type SourceRoute = {
  readonly operation: string;
  readonly method: string;
  readonly routePath: string;
  readonly line: number;
  readonly schemas: ReturnType<typeof readRouteSchemas>;
  readonly declaresAccess: boolean;
  readonly explicitlyPublic?: true;
  readonly resourceFreeTelemetry?: true;
  readonly handlerStatements: number;
  readonly handlerText: string;
};

function mayDeclareRoutes(source: string): boolean {
  return /\b(?:get|list|post|patch|put|delete)Route\b|\bdad\s*\.\s*(?:get|list|post|patch|put|delete)\b/.test(source);
}

export function readRouteSource(text: string, file: string): readonly SourceRoute[] {
  if (!mayDeclareRoutes(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const routes: SourceRoute[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = readRoute(node, source);
      if (route) routes.push(route);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}

function readRoute(call: ts.CallExpression, source: ts.SourceFile): SourceRoute | undefined {
  const builder = builderMethod(call.expression);
  const config = call.arguments[0];
  if (!builder || !config || !ts.isObjectLiteralExpression(config)) return undefined;
  const routePath = readRoutePath(config);
  if (!routePath?.startsWith("/")) return undefined;
  const descriptor = readProperty(config, "route");
  const method = readDescriptorText(descriptor, "method") ?? readText(readProperty(config, "method")) ?? builder;
  const operation = readText(readProperty(config, "operation")) ?? `${method} ${routePath}`;
  return {
    operation,
    method,
    routePath,
    line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
    schemas: readRouteSchemas(config, source),
    ...readAccessFacts(config, source),
    ...readRouteHandler(config, source),
  };
}

function readAccessFacts(
  config: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
): Pick<SourceRoute, "declaresAccess" | "explicitlyPublic" | "resourceFreeTelemetry"> {
  const access = readProperty(config, "access");
  if (usesPublicAccess(access, source)) {
    return {
      declaresAccess: true,
      explicitlyPublic: true,
      ...(declaresResourceFreeTelemetry(config) ? { resourceFreeTelemetry: true } : {}),
    };
  }
  return { declaresAccess: access !== undefined };
}

function usesPublicAccess(access: ts.Node | undefined, source: ts.SourceFile): boolean {
  if (access === undefined || !ts.isCallExpression(access) || access.arguments.length !== 0) return false;
  if (!ts.isIdentifier(access.expression)) return false;
  const name = access.expression.text;
  return importsPublicAccess(source, name) && !shadowsImportedName(source, name);
}

function importsPublicAccess(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    if (statement.moduleSpecifier.text !== "@dads-framework/http") return false;
    if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
    return bindings.elements.some(
      (binding) =>
        !binding.isTypeOnly &&
        binding.name.text === name &&
        (binding.propertyName ?? binding.name).text === "publicAccess",
    );
  });
}

function shadowsImportedName(source: ts.SourceFile, name: string): boolean {
  function isShadow(node: ts.Node): boolean {
    if (ts.isImportDeclaration(node)) return false;
    if (localName(node) === name) return true;
    return ts.forEachChild(node, isShadow) === true;
  }
  return isShadow(source);
}

function localName(node: ts.Node): string | undefined {
  if (
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isBindingElement(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassExpression(node)
  ) {
    return node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
}

function readRoutePath(config: ts.ObjectLiteralExpression): string | undefined {
  return (
    readDescriptorText(readProperty(config, "route"), "template") ??
    readText(readProperty(config, "path")) ??
    readText(readProperty(config, "template"))
  );
}

function readDescriptorText(descriptor: ts.Node | undefined, key: string): string | undefined {
  return descriptor && ts.isObjectLiteralExpression(descriptor) ? readText(readProperty(descriptor, key)) : undefined;
}

function builderMethod(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression) && expression.text.endsWith("Route")) {
    return builders.get(expression.text.slice(0, -5));
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "dad"
  ) {
    return builders.get(expression.name.text);
  }
  return undefined;
}
