import { ts, visitNodes } from "../scanners/typescript-program.js";

type Binding = (identifier: ts.Identifier, module: string, name: string) => boolean;

export function declaresLawTable(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((statement) => {
    if (!ts.isVariableStatement(statement)) return false;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
    return statement.declarationList.declarations.some((declaration) => {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) return false;
      const rows = declaration.initializer;
      return (
        rows !== undefined &&
        ts.isArrayLiteralExpression(rows) &&
        rows.elements.length > 0 &&
        rows.elements.every(hasLaw)
      );
    });
  });
}

function hasLaw(row: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(row)) return false;
  return row.properties.some((property) => {
    if (property.name === undefined || property.name.getText() !== "run") return false;
    if (ts.isMethodDeclaration(property)) return exercisesProvider(property);
    if (!ts.isPropertyAssignment(property)) return false;
    const law = property.initializer;
    return (ts.isArrowFunction(law) || ts.isFunctionExpression(law)) && exercisesProvider(law);
  });
}

function bindingNames(binding: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(binding)) return [binding.text];
  return binding.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

function exercisesProvider(law: ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression): boolean {
  const provider = law.parameters[0]?.name;
  if (provider === undefined || law.body === undefined) return false;
  const names = bindingNames(provider);
  let exercised = false;
  visitNodes(law.body, (node) => {
    if (ts.isIdentifier(node) && names.includes(node.text)) exercised = true;
  });
  return exercised;
}

function lawParameter(callback: ts.ArrowFunction): string | undefined {
  const name = callback.parameters[0]?.name;
  if (name === undefined || !ts.isObjectBindingPattern(name)) return undefined;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name) || element.initializer !== undefined || element.dotDotDotToken !== undefined)
      continue;
    if ((element.propertyName ?? element.name).getText() === "run") return element.name.text;
  }
  return undefined;
}

type Initializers = ReadonlyMap<string, ts.Expression>;

function returnedExpressions(block: ts.Block, initializers: Map<string, ts.Expression>): ts.Expression[] {
  const expressions: ts.Expression[] = [];
  for (const statement of block.statements) {
    if (ts.isVariableStatement(statement)) recordInitializers(statement, initializers);
    if (ts.isReturnStatement(statement) && statement.expression !== undefined) expressions.push(statement.expression);
  }
  return expressions;
}

function shadows(statement: ts.Statement, names: readonly string[]): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(({ name }) =>
      bindingNames(name).some((declared) => names.includes(declared)),
    );
  }
  const declaration = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement);
  return declaration && statement.name !== undefined && names.includes(statement.name.text);
}

function recordInitializers(statement: ts.VariableStatement, initializers: Map<string, ts.Expression>): void {
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return;
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined)
      initializers.set(declaration.name.text, declaration.initializer);
  }
}

function callsImportedProvider(expression: ts.Expression, provider: string, initializers: Initializers): boolean {
  return ts.isIdentifier(expression) && expression.text === provider && !initializers.has(provider);
}

function usesProvider(
  node: ts.Expression,
  provider: string,
  initializers: Initializers,
  seen = new Set<ts.Expression>(),
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isIdentifier(node)) {
    const value = initializers.get(node.text);
    return value === undefined ? node.text === provider : usesProvider(value, provider, initializers, seen);
  }
  if (ts.isNewExpression(node) || ts.isCallExpression(node))
    return callsImportedProvider(node.expression, provider, initializers);
  if (ts.isArrowFunction(node)) return factoryUsesProvider(node, provider, initializers, seen);
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some((property) => fieldUsesProvider(property, provider, initializers, seen))
  );
}

function factoryUsesProvider(
  node: ts.ArrowFunction,
  provider: string,
  initializers: Initializers,
  seen: Set<ts.Expression>,
): boolean {
  const scope = new Map(initializers);
  for (const parameter of node.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.name.text === provider) return false;
    scope.delete(parameter.name.text);
  }
  if (!ts.isBlock(node.body)) return usesProvider(node.body, provider, scope, seen);
  if (node.body.statements.some((statement) => shadows(statement, [provider]))) return false;
  const results = returnedExpressions(node.body, scope);
  return results.length === 1 && results.some((value) => usesProvider(value, provider, scope, seen));
}

function fieldUsesProvider(
  property: ts.ObjectLiteralElementLike,
  provider: string,
  initializers: Initializers,
  seen: Set<ts.Expression>,
): boolean {
  if (ts.isPropertyAssignment(property)) return usesProvider(property.initializer, provider, initializers, seen);
  if (ts.isShorthandPropertyAssignment(property)) return usesProvider(property.name, provider, initializers, seen);
  return false;
}

function invokesLaw(
  statement: ts.Statement,
  law: string,
  provider: string,
  initializers: Map<string, ts.Expression>,
): boolean {
  if (ts.isVariableStatement(statement)) recordInitializers(statement, initializers);
  if (ts.isTryStatement(statement)) {
    const scope = new Map(initializers);
    return blockInvokesLaw(statement.tryBlock, law, provider, scope);
  }
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === law &&
    !initializers.has(law) &&
    expression.arguments.some((argument) => usesProvider(argument, provider, initializers))
  );
}

function blockInvokesLaw(
  block: ts.Block,
  law: string,
  provider: string,
  initializers: Map<string, ts.Expression>,
): boolean {
  if (block.statements.some((statement) => shadows(statement, [law, provider]))) return false;
  return block.statements.some((statement) => invokesLaw(statement, law, provider, initializers));
}

function isTableCall(call: ts.CallExpression, suite: string, binding: Binding): boolean {
  const table = call.expression;
  if (!ts.isCallExpression(table) || !ts.isPropertyAccessExpression(table.expression)) return false;
  const runner = table.expression;
  const rows = table.arguments[0];
  return (
    runner.name.text === "each" &&
    ts.isIdentifier(runner.expression) &&
    binding(runner.expression, "vitest", "it") &&
    rows !== undefined &&
    ts.isIdentifier(rows) &&
    rows.text === suite
  );
}

function isDescribe(call: ts.CallExpression, binding: Binding): boolean {
  return ts.isIdentifier(call.expression) && binding(call.expression, "vitest", "describe");
}

function statementRunsTable(statement: ts.Statement, suite: string, provider: string, binding: Binding): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  const callback = call.arguments[1];
  if (callback === undefined || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) return false;
  if (isDescribe(call, binding)) {
    return groupRunsTable(callback, callback.body, suite, provider, binding);
  }
  return isTableCall(call, suite, binding) && testRunsLaw(callback, callback.body, provider);
}

function groupRunsTable(
  callback: ts.ArrowFunction,
  body: ts.Block,
  suite: string,
  provider: string,
  binding: Binding,
): boolean {
  if (callback.parameters.length !== 0) return false;
  if (body.statements.some((nested) => shadows(nested, [suite, provider]))) return false;
  return body.statements.some((nested) => statementRunsTable(nested, suite, provider, binding));
}

function testRunsLaw(callback: ts.ArrowFunction, body: ts.Block, provider: string): boolean {
  if (callback.parameters.some(({ name }) => bindingNames(name).includes(provider))) return false;
  const law = lawParameter(callback);
  if (law === undefined || law === provider) return false;
  return blockInvokesLaw(body, law, provider, new Map());
}

export function runsLawTable(source: ts.SourceFile, suite: string, provider: string, binding: Binding): boolean {
  return source.statements.some((statement) => statementRunsTable(statement, suite, provider, binding));
}
