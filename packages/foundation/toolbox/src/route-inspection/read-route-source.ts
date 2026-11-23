import ts from "typescript";
import {
  createRouteReferenceResolver,
  type RouteFileReader,
  type RouteReferenceResolver,
} from "./resolve-route-references.js";
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

type RouteBuilderKind = {
  readonly method: string | undefined;
  readonly raw: boolean;
};

export type ReadRouteSourceOptions = {
  readonly readFile?: RouteFileReader;
};

export type SourceRoute = {
  readonly operation: string;
  readonly method: string;
  readonly routePath: string;
  readonly line: number;
  readonly schemas: ReturnType<typeof readRouteSchemas>;
  readonly declaresAccess: boolean;
  readonly explicitlyPublic?: true;
  readonly resourceFreeTelemetry?: true;
  readonly raw?: true;
  readonly handlerStatements: number;
  readonly handlerText: string;
};

function mayDeclareRoutes(source: string): boolean {
  return /\b(?:(?:get|list|post|patch|put|delete)Route|defineRawRoute|sseRoute)\b|\bdad\s*\.\s*(?:get|list|post|patch|put|delete)\b/.test(
    source,
  );
}

export function readRouteSource(text: string, file: string, options?: ReadRouteSourceOptions): readonly SourceRoute[] {
  if (!mayDeclareRoutes(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const resolver = createRouteReferenceResolver(source, file, options?.readFile);
  const routes: SourceRoute[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = readRoute(node, source, resolver);
      if (route) routes.push(route);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}

function resolveEndpointPath(
  config: ts.ObjectLiteralExpression,
  resolver: RouteReferenceResolver,
  descriptorPath: string | undefined,
  operationPath: string | undefined,
): string | undefined {
  const inlinePath = resolver.resolveString(readProperty(config, "path") ?? readProperty(config, "template"));
  const candidate = descriptorPath ?? inlinePath ?? operationPath;
  return candidate?.startsWith("/") ? candidate : undefined;
}

function resolveEndpointMethod(
  config: ts.ObjectLiteralExpression,
  resolver: RouteReferenceResolver,
  descriptorMethod: string | undefined,
  operationMethod: string | undefined,
  defaultMethod: string | undefined,
): string | undefined {
  return descriptorMethod ?? resolver.resolveString(readProperty(config, "method")) ?? operationMethod ?? defaultMethod;
}

function resolveRouteEndpoint(
  config: ts.ObjectLiteralExpression,
  resolver: RouteReferenceResolver,
  defaultMethod: string | undefined,
) {
  const operationNode = readProperty(config, "operation");
  const resolvedOperation = resolver.resolveOperation(operationNode);
  const descriptor = resolver.resolveDescriptor(readProperty(config, "route"));
  const routePath = resolveEndpointPath(config, resolver, descriptor?.routePath, resolvedOperation?.routePath);
  if (!routePath) return undefined;
  const method = resolveEndpointMethod(config, resolver, descriptor?.method, resolvedOperation?.method, defaultMethod);
  if (!method) return undefined;
  return {
    method,
    routePath,
    operation: readText(operationNode) ?? `${method} ${routePath}`,
    resolvedSchemas: resolvedOperation?.schemas ?? {},
  };
}

function readRoute(
  call: ts.CallExpression,
  source: ts.SourceFile,
  resolver: RouteReferenceResolver,
): SourceRoute | undefined {
  const builder = builderKind(call.expression);
  const config = call.arguments[0];
  if (!builder || !config || !ts.isObjectLiteralExpression(config)) return undefined;
  const endpoint = resolveRouteEndpoint(config, resolver, builder.method);
  if (!endpoint) return undefined;
  return {
    operation: endpoint.operation,
    method: endpoint.method,
    routePath: endpoint.routePath,
    line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
    schemas: { ...endpoint.resolvedSchemas, ...readRouteSchemas(config, source) },
    ...(builder.raw ? { raw: true } : {}),
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

function builderKind(expression: ts.Expression): RouteBuilderKind | undefined {
  if (ts.isIdentifier(expression)) {
    if (expression.text === "defineRawRoute") return { method: undefined, raw: true };
    if (expression.text === "sseRoute") return { method: "GET", raw: true };
    if (expression.text.endsWith("Route")) {
      const method = builders.get(expression.text.slice(0, -5));
      return method !== undefined ? { method, raw: false } : undefined;
    }
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "dad"
  ) {
    const method = builders.get(expression.name.text);
    return method !== undefined ? { method, raw: false } : undefined;
  }
  return undefined;
}
