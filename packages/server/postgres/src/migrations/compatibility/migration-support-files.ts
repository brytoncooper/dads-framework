import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

import type { MigrationWorkspace } from "../index.js";

/**
 * The source files the given migrations load at run time, beyond the
 * migrations themselves: relative imports and the workspace's module aliases,
 * followed transitively. A rehearsal copies exactly these.
 */
export async function migrationSupportFiles(
  workspace: MigrationWorkspace,
  migrationFiles: readonly string[],
): Promise<readonly string[]> {
  const root = workspace.root;
  const migrations = new Set(migrationFiles.map((file) => resolve(root, file)));
  const visited = new Set<string>();
  const supports = new Set<string>();
  for (const file of migrations) await visit(file);
  return [...supports].sort();

  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const specifier of runtimeImports(source)) {
      const helper = workspace.moduleAliases[specifier];
      const candidate =
        helper !== undefined
          ? join(root, helper)
          : specifier.startsWith(".")
            ? resolve(dirname(file), specifier)
            : undefined;
      if (candidate === undefined) continue;
      const dependency = await resolveModuleFile(candidate);
      const path = relative(root, dependency);
      if (path.startsWith("..") || isAbsolute(path)) throw new Error("migration support is outside the workspace");
      if (dependency.endsWith(".migration.ts"))
        throw new Error(`migration support cannot import another migration: ${path}`);
      supports.add(path);
      await visit(dependency);
    }
  }
}

async function resolveModuleFile(candidate: string): Promise<string> {
  const extensionless = candidate.replace(/\.[cm]?js$/, "");
  const paths = [
    candidate,
    extensionless,
    `${extensionless}.ts`,
    `${extensionless}.mts`,
    `${extensionless}.cts`,
    `${extensionless}.js`,
    join(extensionless, "index.ts"),
    join(extensionless, "index.mts"),
    join(extensionless, "index.cts"),
  ];
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch (error: unknown) {
      if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`missing migration support module ${candidate}`);
}

function runtimeImports(source: ts.SourceFile): readonly string[] {
  const imports: string[] = [];
  function collect(node: ts.Node): void {
    const specifier = runtimeImportSpecifier(node) ?? runtimeReExportSpecifier(node) ?? dynamicImportSpecifier(node);
    if (specifier !== undefined) imports.push(specifier);
    ts.forEachChild(node, collect);
  }
  collect(source);
  return imports;
}

/** `import ... from "x"`, unless every binding it brings in is a type. */
function runtimeImportSpecifier(node: ts.Node): string | undefined {
  if (
    !ts.isImportDeclaration(node) ||
    node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    !ts.isStringLiteral(node.moduleSpecifier)
  )
    return undefined;
  const clause = node.importClause;
  return importsOnlyTypes(clause) ? undefined : node.moduleSpecifier.text;
}

function importsOnlyTypes(clause: ts.ImportClause | undefined): boolean {
  const bindings = clause?.namedBindings;
  return (
    clause?.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/** `export ... from "x"` that is not `export type`. */
function runtimeReExportSpecifier(node: ts.Node): string | undefined {
  if (
    ts.isExportDeclaration(node) &&
    !node.isTypeOnly &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  )
    return node.moduleSpecifier.text;
  return undefined;
}

/** `import("x")` or `require("x")`; a computed specifier cannot be rehearsed. */
function dynamicImportSpecifier(node: ts.Node): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !(
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )
  )
    return undefined;
  const argument = node.arguments[0];
  if (argument === undefined || !ts.isStringLiteral(argument))
    throw new Error("dynamic migration support imports require a dedicated rehearsal");
  return argument.text;
}
