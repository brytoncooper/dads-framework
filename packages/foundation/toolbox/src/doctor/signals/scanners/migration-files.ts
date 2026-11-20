/**
 * What a migration file is, and what it says about the migrations before it.
 *
 * A migration is a TypeScript module named `<14-digit stamp>_<name>.migration.ts`
 * — the shape the server kits ship and the shape their runner reads. Its
 * journal is the directory it sits in: every kit keeps its own, and the order
 * that matters is the order inside one directory.
 *
 * A migration either leaves its order to its stamp, or states it: an exported
 * `const dependsOn` holding a literal array of the journal names it runs after.
 * A statement the runner cannot read — not exported, not `const`, not a
 * literal array of journal names, or one name twice — is its own answer, so
 * the reader below says `invalid` rather than guessing what was meant.
 */

import { ts } from "./typescript-program.js";

const MIGRATION_FILE = /(?:^|\/)(\d{14})_[^/]+\.migration\.ts$/;
const JOURNAL_NAME = /^\d{14}_[a-z0-9_]+\.migration$/;
const DEPENDS_ON = "dependsOn";
const MODULE_SUFFIX = ".ts";

/** How a migration declares the migrations it runs after. */
export type MigrationPrerequisites =
  | { readonly kind: "stamp" }
  | { readonly kind: "invalid" }
  | { readonly kind: "graph"; readonly dependencies: readonly string[] };

/** True for a migration module, wherever it sits. */
export function isMigrationFile(path: string): boolean {
  return MIGRATION_FILE.test(path);
}

/** The fourteen-digit stamp a migration file name starts with. */
export function migrationStamp(path: string): string {
  return MIGRATION_FILE.exec(path)?.[1] ?? "";
}

/** The directory a migration sits in, which is the journal it belongs to. */
export function migrationJournal(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** The name another migration's `dependsOn` uses for this one. */
export function migrationName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(MODULE_SUFFIX)
    ? base.slice(0, -MODULE_SUFFIX.length)
    : base;
}

function isExportedConst(statement: ts.VariableStatement): boolean {
  const exported = (statement.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
  const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  return exported && constant;
}

function readDependencyList(
  initializer: ts.Expression | undefined,
): MigrationPrerequisites {
  if (initializer === undefined) return { kind: "invalid" };
  if (!ts.isArrayLiteralExpression(initializer)) return { kind: "invalid" };
  const dependencies: string[] = [];
  for (const element of initializer.elements) {
    if (!ts.isStringLiteral(element)) return { kind: "invalid" };
    if (!JOURNAL_NAME.test(element.text)) return { kind: "invalid" };
    dependencies.push(element.text);
  }
  if (new Set(dependencies).size !== dependencies.length) {
    return { kind: "invalid" };
  }
  return { kind: "graph", dependencies };
}

function dependsOnDeclaration(
  statement: ts.Statement,
): ts.VariableDeclaration | undefined {
  if (!ts.isVariableStatement(statement)) return undefined;
  return statement.declarationList.declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === DEPENDS_ON,
  );
}

/** How one migration's source declares its prerequisites. */
export function readPrerequisites(
  path: string,
  text: string,
): MigrationPrerequisites {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    const declaration = dependsOnDeclaration(statement);
    if (declaration === undefined) continue;
    if (!ts.isVariableStatement(statement) || !isExportedConst(statement)) {
      return { kind: "invalid" };
    }
    return readDependencyList(declaration.initializer);
  }
  return { kind: "stamp" };
}
