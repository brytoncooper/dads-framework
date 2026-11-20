import ts from "typescript";

type ModuleReference = {
  readonly literal: ts.StringLiteralLike;
  readonly node: ts.Node;
  readonly require: boolean;
};

export function moduleReferences(
  source: ts.SourceFile,
): readonly ModuleReference[] {
  const references: ModuleReference[] = [];
  function visit(node: ts.Node): void {
    const reference = moduleReference(node);
    if (reference) references.push(reference);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}

function moduleReference(node: ts.Node): ModuleReference | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return fromLiteral(node.moduleSpecifier, node);
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return fromLiteral(node.argument.literal, node);
  }
  if (ts.isExternalModuleReference(node)) {
    return fromLiteral(node.expression, node, true);
  }
  if (!ts.isCallExpression(node)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return fromLiteral(node.arguments[0], node);
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return fromLiteral(node.arguments[0], node, true);
  }
  return undefined;
}

function fromLiteral(
  literal: ts.Node | undefined,
  node: ts.Node,
  require = false,
): ModuleReference | undefined {
  return literal && ts.isStringLiteralLike(literal)
    ? { literal, node, require }
    : undefined;
}
