import { posix } from "node:path";

import { isRecord, isString } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import { ts } from "../scanners/typescript-program.js";

export type ImportReference = {
  readonly module: string;
  readonly name: string;
};

export function sourceFile(
  context: DoctorContext,
  file: string,
): ts.SourceFile {
  return ts.createSourceFile(
    file,
    context.read(file),
    ts.ScriptTarget.Latest,
    true,
  );
}

export function localModule(
  root: string,
  file: string,
  specifier: string,
): string | undefined {
  const resolved = posix
    .normalize(posix.join(posix.dirname(file), specifier))
    .replace(/\.[cm]?js$/, ".ts");
  return resolved.startsWith(`${root}/`) ? resolved : undefined;
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

function providerClass(
  source: ts.SourceFile,
  name: string,
): string | undefined {
  const matches = source.statements.some(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === name &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) &&
      statement.members.some(ts.isMethodDeclaration),
  );
  return matches ? name : constructedClass(source, name);
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

export function providerIdentity(
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
  const className = providerClass(sourceFile(context, file), provider.name);
  return className === undefined ? undefined : `${file}#${className}`;
}
