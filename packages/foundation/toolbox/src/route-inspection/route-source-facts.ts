import ts from "typescript";

const fields = [
  "params",
  "body",
  "query",
  "headers",
  "response",
  "item",
] as const;
type SchemaField = (typeof fields)[number];

export function readProperty(object: ts.ObjectLiteralExpression, key: string) {
  const property = object.properties.find(({ name }) => {
    if (!name) return false;
    return (
      (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === key
    );
  });
  if (!property) return undefined;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  if (ts.isMethodDeclaration(property)) return property;
  return undefined;
}

export function readText(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** Match an explicit public telemetry declaration without accepting spread overrides. */
export function declaresResourceFreeTelemetry(
  config: ts.ObjectLiteralExpression,
): boolean {
  const policy = readProperty(config, "resourcePolicy");
  const status = readProperty(config, "status");
  return (
    policy !== undefined &&
    ts.isObjectLiteralExpression(policy) &&
    policy.properties.length === 2 &&
    readText(readProperty(policy, "kind")) === "resource-free" &&
    readText(readProperty(policy, "purpose")) === "append-only-telemetry" &&
    status !== undefined &&
    ts.isNumericLiteral(status) &&
    status.text === "200" &&
    readProperty(config, "body") !== undefined &&
    config.properties.every((property) => !ts.isSpreadAssignment(property))
  );
}

export function readRouteSchemas(
  config: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
): Partial<Record<SchemaField, string>> {
  const schemas: Partial<Record<SchemaField, string>> = {};
  for (const key of fields) {
    const schema = readProperty(config, key);
    if (schema) schemas[key] = schema.getText(source);
  }
  return schemas;
}

export function readRouteHandler(
  config: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
) {
  const handler = readProperty(config, "handler");
  if (!handler) return { handlerStatements: 0, handlerText: "" };
  const body = handlerBody(handler);
  return {
    handlerStatements: body && ts.isBlock(body) ? countStatements(body) : 1,
    handlerText: handler.getText(source),
  };
}

function handlerBody(handler: ts.Node) {
  if (
    ts.isArrowFunction(handler) ||
    ts.isFunctionExpression(handler) ||
    ts.isMethodDeclaration(handler)
  ) {
    return handler.body;
  }
  return undefined;
}

function countStatements(body: ts.Block): number {
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isStatement(node) && !ts.isBlock(node)) count += 1;
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return count;
}
