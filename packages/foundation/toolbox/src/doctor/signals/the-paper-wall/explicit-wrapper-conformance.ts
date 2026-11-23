import { posix } from "node:path";

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import { ts, visitNodes } from "../scanners/typescript-program.js";

import { declaresLawTable, runsLawTable } from "./table-wrapper-conformance.js";
import { localModule, providerIdentity, sourceFile, type ImportReference } from "./wrapper-conformance-provider.js";

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
  if (!isString(test) || !isString(provider["name"]) || !isString(provider["module"])) {
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
  if (!isString(capability) || !isString(suite) || !isString(law)) return undefined;
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

function namedRuntimeImports(statement: ts.ImportDeclaration): readonly ts.ImportSpecifier[] {
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return [];
  const named = clause.namedBindings;
  if (named === undefined || !ts.isNamedImports(named)) return [];
  return named.elements.filter((binding) => !binding.isTypeOnly);
}

function readImports(source: ts.SourceFile): ReadonlyMap<string, ImportReference> {
  const imports = new Map<string, ImportReference>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const binding of namedRuntimeImports(statement)) {
      imports.set(binding.name.text, {
        module: statement.moduleSpecifier.text,
        name: (binding.propertyName ?? binding.name).text,
      });
    }
  }
  return imports;
}

function parameterName(parameter: ts.ParameterDeclaration | undefined): string | undefined {
  return parameter !== undefined && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function callsName(node: ts.Node, name: string): boolean {
  let called = false;
  function inspect(child: ts.Node): void {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) {
      called = true;
    }
  }
  inspect(node);
  visitNodes(node, inspect);
  return called;
}

function registersLaw(statement: ts.Statement, register: string, open: string): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const { expression, arguments: args } = statement.expression;
  if (!ts.isIdentifier(expression) || expression.text !== register) return false;
  const [title, law] = args;
  if (title === undefined || !ts.isStringLiteral(title) || title.text.trim().length === 0) return false;
  return law !== undefined && ts.isArrowFunction(law) && callsName(law.body, open);
}

function declaresLaw(source: ts.SourceFile, name: string): boolean {
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (declaration?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true) return false;
  const open = parameterName(declaration.parameters[0]);
  const register = parameterName(declaration.parameters[1]);
  return (
    open !== undefined &&
    register !== undefined &&
    declaration.body?.statements.some((statement) => registersLaw(statement, register, open)) === true
  );
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
  return imported?.module === provider.module && imported.name === provider.name;
}

function invokesLawInTest(call: ts.CallExpression, imports: ReadonlyMap<string, ImportReference>): boolean {
  const register = call.arguments[1];
  if (register === undefined || !ts.isArrowFunction(register)) return false;
  const law = parameterName(register.parameters[1]);
  if (law === undefined || !ts.isBlock(register.body)) return false;
  return register.body.statements.some((statement) => isTestInvokingLaw(statement, imports, law));
}

function isTestInvokingLaw(
  statement: ts.Statement,
  imports: ReadonlyMap<string, ImportReference>,
  law: string,
): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const { expression, arguments: args } = statement.expression;
  if (!ts.isIdentifier(expression)) return false;
  const runner = imports.get(expression.text);
  if (runner?.module !== "vitest" || runner.name !== "it") return false;
  const code = args[1];
  return code !== undefined && ts.isArrowFunction(code) && callsName(code.body, law);
}

function runsLaw(source: ts.SourceFile, root: string, suite: string, law: string, provider: ImportReference): boolean {
  const imports = readImports(source);
  return source.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression)) return false;
    const runner = imports.get(call.expression.text);
    if (runner === undefined || runner.name !== law || !runner.module.startsWith(".")) return false;
    if (localModule(root, source.fileName, runner.module) !== suite) return false;
    return providerUsedInRun(call, imports, provider) && invokesLawInTest(call, imports);
  });
}

function runsDeclaredTable(
  source: ts.SourceFile,
  root: string,
  suite: string,
  law: string,
  provider: ImportReference,
): boolean {
  const imports = readImports(source);
  const entries = [...imports];
  const suiteBinding = entries.find(
    ([, reference]) =>
      reference.name === law &&
      reference.module.startsWith(".") &&
      localModule(root, source.fileName, reference.module) === suite,
  )?.[0];
  if (suiteBinding === undefined) return false;
  const providerBinding = entries.find(
    ([, reference]) => reference.module === provider.module && reference.name === provider.name,
  )?.[0];
  if (providerBinding === undefined) return false;
  return runsLawTable(source, suiteBinding, providerBinding, (identifier, module, name) => {
    const reference = imports.get(identifier.text);
    return reference?.module === module && reference.name === name;
  });
}

function hasConformance(context: DoctorContext, root: string, conformance: Conformance): boolean {
  const files = context.files();
  const suite = packageFile(root, conformance.suite);
  if (suite === undefined || !files.includes(suite)) return false;
  const source = sourceFile(context, suite);
  const table = declaresLawTable(source, conformance.law);
  if (!table && !declaresLaw(source, conformance.law)) return false;
  const providers = new Set<string>();
  for (const run of conformance.runs) {
    const provider = checkedRunIdentity(context, root, suite, conformance.law, run, table);
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
  table: boolean,
): string | undefined {
  const test = packageFile(root, run.test);
  if (test === undefined || !/\.test\.tsx?$/.test(test) || !context.files().includes(test)) return undefined;
  const source = sourceFile(context, test);
  const runs = table ? runsDeclaredTable : runsLaw;
  if (!runs(source, root, suite, law, run.provider)) return undefined;
  return providerIdentity(context, root, test, run.provider);
}

export function hasExplicitWrapperConformance(context: DoctorContext, root: string): boolean {
  const manifest = `${root}/package.json`;
  if (!context.exists(manifest)) return false;
  const parsed: unknown = JSON.parse(context.read(manifest));
  if (!isRecord(parsed)) return false;
  const conformance = parseConformance(parsed["dadsConformance"]);
  return conformance !== undefined && hasConformance(context, root, conformance);
}
