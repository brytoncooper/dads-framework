import { posix } from "node:path";

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import { ts, visitNodes } from "../scanners/typescript-program.js";

type ImportReference = {
  readonly module: string;
  readonly name: string;
};

type ConformanceRun = {
  readonly test: string;
  readonly provider: ImportReference;
};

type Conformance = {
  readonly capability: string;
  readonly suite: string;
  readonly law: string;
  readonly runs: readonly ConformanceRun[];
};

function parseRun(raw: unknown): ConformanceRun | undefined {
  if (!isRecord(raw) || !isRecord(raw["provider"])) return undefined;
  const { test, provider } = raw;
  if (
    !isString(test) ||
    !isString(provider["name"]) ||
    !isString(provider["module"])
  ) {
    return undefined;
  }
  return {
    test,
    provider: { module: provider["module"], name: provider["name"] },
  };
}

function parseConformance(raw: unknown): Conformance | undefined {
  if (!isRecord(raw)) return undefined;
  const { capability, suite, law, runs } = raw;
  if (!isString(capability) || !isString(suite) || !isString(law))
    return undefined;
  if (capability.trim().length === 0 || !isUnknownArray(runs)) return undefined;
  const parsed = runs.map(parseRun);
  if (parsed.some((run) => run === undefined)) return undefined;
  return {
    capability,
    suite,
    law,
    runs: parsed.filter((run) => run !== undefined),
  };
}

function packageFile(root: string, path: string): string | undefined {
  const file = posix.normalize(posix.join(root, path));
  return file.startsWith(`${root}/`) ? file : undefined;
}

function sourceFile(context: DoctorContext, file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    context.read(file),
    ts.ScriptTarget.Latest,
    true,
  );
}

function namedRuntimeImports(
  statement: ts.ImportDeclaration,
): readonly ts.ImportSpecifier[] {
  const clause = statement.importClause;
  if (
    clause === undefined ||
    clause.phaseModifier === ts.SyntaxKind.TypeKeyword
  )
    return [];
  const named = clause.namedBindings;
  if (named === undefined || !ts.isNamedImports(named)) return [];
  return named.elements.filter((binding) => !binding.isTypeOnly);
}

function readImports(
  source: ts.SourceFile,
): ReadonlyMap<string, ImportReference> {
  const imports = new Map<string, ImportReference>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    for (const binding of namedRuntimeImports(statement)) {
      imports.set(binding.name.text, {
        module: statement.moduleSpecifier.text,
        name: (binding.propertyName ?? binding.name).text,
      });
    }
  }
  return imports;
}

function localModule(
  root: string,
  file: string,
  specifier: string,
): string | undefined {
  const resolved = posix
    .normalize(posix.join(posix.dirname(file), specifier))
    .replace(/\.[cm]?js$/, ".ts");
  return resolved.startsWith(`${root}/`) ? resolved : undefined;
}

function parameterName(
  parameter: ts.ParameterDeclaration | undefined,
): string | undefined {
  return parameter !== undefined && ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : undefined;
}

function callsName(node: ts.Node, name: string): boolean {
  let called = false;
  function inspect(child: ts.Node): void {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === name
    ) {
      called = true;
    }
  }
  inspect(node);
  visitNodes(node, inspect);
  return called;
}

function registersLaw(
  statement: ts.Statement,
  register: string,
  open: string,
): boolean {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression)
  )
    return false;
  const { expression, arguments: args } = statement.expression;
  if (!ts.isIdentifier(expression) || expression.text !== register)
    return false;
  const [title, law] = args;
  if (
    title === undefined ||
    !ts.isStringLiteral(title) ||
    title.text.trim().length === 0
  )
    return false;
  return (
    law !== undefined && ts.isArrowFunction(law) && callsName(law.body, open)
  );
}

function declaresLaw(source: ts.SourceFile, name: string): boolean {
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (
    declaration?.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) !== true
  )
    return false;
  const open = parameterName(declaration.parameters[0]);
  const register = parameterName(declaration.parameters[1]);
  return (
    open !== undefined &&
    register !== undefined &&
    declaration.body?.statements.some((statement) =>
      registersLaw(statement, register, open),
    ) === true
  );
}

function constructedClass(
  source: ts.SourceFile,
  factory: string,
): string | undefined {
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === factory,
  );
  if (declaration?.body?.statements.length !== 1) return undefined;
  const returned = declaration.body.statements[0];
  if (returned === undefined || !ts.isReturnStatement(returned))
    return undefined;
  const expression = returned.expression;
  if (expression === undefined || !ts.isNewExpression(expression))
    return undefined;
  if (!ts.isIdentifier(expression.expression)) return undefined;
  const name = expression.expression.text;
  const declared = source.statements.some(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === name &&
      statement.members.some(ts.isMethodDeclaration),
  );
  return declared ? name : undefined;
}

function dependencyAlias(
  context: DoctorContext,
  root: string,
  name: string,
): string {
  const manifest: unknown = JSON.parse(context.read(`${root}/package.json`));
  if (!isRecord(manifest)) return name;
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[key];
    if (!isRecord(dependencies)) continue;
    const reference = dependencies[name];
    if (!isString(reference) || !reference.startsWith("npm:")) continue;
    return /^npm:(@[^/]+\/[^@/]+|[^@/]+)(?:@|$)/.exec(reference)?.[1] ?? name;
  }
  return name;
}

function providerIdentity(
  context: DoctorContext,
  root: string,
  test: string,
  provider: ImportReference,
): string | undefined {
  if (!provider.module.startsWith(".")) {
    const base = provider.module.match(/^(@[^/]+\/[^/]+|[^/]+)$/)?.[0];
    if (base === undefined || base.startsWith("node:")) return undefined;
    return dependencyAlias(context, root, base);
  }
  const file = localModule(root, test, provider.module);
  if (file === undefined || !context.files().includes(file)) return undefined;
  const className = constructedClass(sourceFile(context, file), provider.name);
  return className === undefined ? undefined : `${file}#${className}`;
}

function providerUsedInRun(
  call: ts.CallExpression,
  imports: ReadonlyMap<string, ImportReference>,
  provider: ImportReference,
): boolean {
  const factory = call.arguments[0];
  if (factory === undefined || !ts.isArrowFunction(factory)) return false;
  const body = factory.body;
  if (!ts.isCallExpression(body) && !ts.isNewExpression(body)) return false;
  if (!ts.isIdentifier(body.expression)) return false;
  const imported = imports.get(body.expression.text);
  return (
    imported?.module === provider.module && imported.name === provider.name
  );
}

function invokesLawInTest(
  call: ts.CallExpression,
  imports: ReadonlyMap<string, ImportReference>,
): boolean {
  const register = call.arguments[1];
  if (register === undefined || !ts.isArrowFunction(register)) return false;
  const law = parameterName(register.parameters[1]);
  if (law === undefined || !ts.isBlock(register.body)) return false;
  return register.body.statements.some((statement) =>
    isTestInvokingLaw(statement, imports, law),
  );
}

function isTestInvokingLaw(
  statement: ts.Statement,
  imports: ReadonlyMap<string, ImportReference>,
  law: string,
): boolean {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression)
  )
    return false;
  const { expression, arguments: args } = statement.expression;
  if (!ts.isIdentifier(expression)) return false;
  const runner = imports.get(expression.text);
  if (runner?.module !== "vitest" || runner.name !== "it") return false;
  const code = args[1];
  return (
    code !== undefined && ts.isArrowFunction(code) && callsName(code.body, law)
  );
}

function runsLaw(
  source: ts.SourceFile,
  root: string,
  suite: string,
  law: string,
  provider: ImportReference,
): boolean {
  const imports = readImports(source);
  return source.statements.some((statement) => {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      return false;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression)) return false;
    const runner = imports.get(call.expression.text);
    if (
      runner === undefined ||
      runner.name !== law ||
      !runner.module.startsWith(".")
    )
      return false;
    if (localModule(root, source.fileName, runner.module) !== suite)
      return false;
    return (
      providerUsedInRun(call, imports, provider) &&
      invokesLawInTest(call, imports)
    );
  });
}

function hasConformance(
  context: DoctorContext,
  root: string,
  conformance: Conformance,
): boolean {
  const files = context.files();
  const suite = packageFile(root, conformance.suite);
  if (suite === undefined || !files.includes(suite)) return false;
  if (!declaresLaw(sourceFile(context, suite), conformance.law)) return false;
  const providers = new Set<string>();
  for (const run of conformance.runs) {
    const provider = checkedRunIdentity(
      context,
      root,
      suite,
      conformance.law,
      run,
    );
    if (provider === undefined || providers.has(provider)) return false;
    providers.add(provider);
  }
  return providers.size >= 2;
}

function checkedRunIdentity(
  context: DoctorContext,
  root: string,
  suite: string,
  law: string,
  run: ConformanceRun,
): string | undefined {
  const test = packageFile(root, run.test);
  if (
    test === undefined ||
    !/\.test\.tsx?$/.test(test) ||
    !context.files().includes(test)
  )
    return undefined;
  if (!runsLaw(sourceFile(context, test), root, suite, law, run.provider))
    return undefined;
  return providerIdentity(context, root, test, run.provider);
}

export function hasExplicitWrapperConformance(
  context: DoctorContext,
  root: string,
): boolean {
  const manifest = `${root}/package.json`;
  if (!context.exists(manifest)) return false;
  const parsed: unknown = JSON.parse(context.read(manifest));
  if (!isRecord(parsed)) return false;
  const conformance = parseConformance(parsed["dadsConformance"]);
  return (
    conformance !== undefined && hasConformance(context, root, conformance)
  );
}
