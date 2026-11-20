/**
 * A domain type that is a vendor type wearing a local name: ceiling 0.
 *
 * `type Order = Row` is not a domain type. It is a rename, and every property
 * the vendor adds or removes arrives in the domain without anybody deciding it
 * should. The same is true of `interface Order extends Row` and of a class
 * that extends a vendor base: the domain has taken the vendor's last name, and
 * from then on the vendor decides what an order is.
 *
 * Only direct aliases and `extends` clauses count. A domain type that *holds*
 * a vendor value in a field has made a different mistake — that is a foreign
 * type in the surface, which `vendor-types-in-surface` reads — and a type that
 * aliases another workspace package's type has not left the house at all.
 *
 * A private subclass inside an adapter or binding may extend a declared
 * vendor class. For example, a checkout decorator can keep the vendor pool's
 * runtime identity while the factory returns its declared public handle.
 * Exported subclasses and all domain aliases remain subject to the rule.
 */

import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  evidenceAt,
  importedBindings,
  isLocalSpecifier,
  isProductionModule,
  leftmostTypeName,
  packageOfSpecifier,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

/**
 * The name a type is an alias of. Only a bare name counts: `z.infer<typeof
 * schema>` reaches through a vendor's namespace to describe a schema this
 * package wrote, which is the opposite move from taking the vendor's type.
 */
function aliasTargets(type: ts.TypeNode): readonly string[] {
  if (ts.isTypeReferenceNode(type)) {
    return ts.isIdentifier(type.typeName)
      ? [leftmostTypeName(type.typeName)]
      : [];
  }
  if (ts.isIntersectionTypeNode(type)) return type.types.flatMap(aliasTargets);
  return [];
}

function extendedNames(
  clauses: ts.NodeArray<ts.HeritageClause> | undefined,
): readonly string[] {
  const names: string[] = [];
  for (const clause of clauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const entry of clause.types) {
      if (ts.isIdentifier(entry.expression)) names.push(entry.expression.text);
    }
  }
  return names;
}

/** The names a declaration takes its identity from. */
function borrowedNames(node: ts.Node): readonly string[] {
  if (ts.isTypeAliasDeclaration(node)) return aliasTargets(node.type);
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    return extendedNames(node.heritageClauses);
  }
  return [];
}

function exportsName(statement: ts.Statement, name: string): boolean {
  if (ts.isExportAssignment(statement)) {
    return (
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === name
    );
  }
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier !== undefined
  ) {
    return false;
  }
  const clause = statement.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.some(
      (element) => (element.propertyName ?? element.name).text === name,
    )
  );
}

function isPrivateVendorSubclass(
  node: ts.Node,
  owner: DoctorPackage | undefined,
  vendor: string,
): boolean {
  if (!ts.isClassDeclaration(node) || node.name === undefined) return false;
  if (owner?.kind !== "adapter" && owner?.kind !== "binding") return false;
  if (!owner.allowedDependencies.includes(vendor)) return false;
  if (
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  ) {
    return false;
  }
  const name = node.name.text;
  return !node
    .getSourceFile()
    .statements.some((statement) => exportsName(statement, name));
}

function borrowedFromVendor(
  module: DoctorModule,
  workspace: ReadonlySet<string>,
  owner: DoctorPackage | undefined,
): readonly SignalEvidence[] {
  const bindings = importedBindings(module);
  const found: SignalEvidence[] = [];
  visitNodes(module.source, (node) => {
    for (const name of borrowedNames(node)) {
      const specifier = bindings.get(name);
      if (specifier === undefined || isLocalSpecifier(specifier)) continue;
      const vendor = packageOfSpecifier(specifier);
      if (workspace.has(vendor)) continue;
      if (isPrivateVendorSubclass(node, owner, vendor)) continue;
      found.push(evidenceAt(module, node, `${name} from ${specifier}`));
    }
  });
  return found;
}

function countVendorNamedDomain(context: DoctorContext): SignalReadings {
  const packages = context.packages();
  const workspace = new Set(packages.map((declared) => declared.name));
  const owners = new Map(packages.map((declared) => [declared.root, declared]));
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    const evidence = borrowedFromVendor(
      module,
      workspace,
      owners.get(module.packageRoot),
    );
    readings.set(module.path, { value: evidence.length, evidence });
  }
  return readings;
}

export const vendorNamedDomainSignal: DoctorSignal = {
  id: "vendor-named-domain",
  issue: "you-are-looking-for-a-father-figure",
  question: "Does any domain type extend or alias a vendor type?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "A vendor can implement a capability. It cannot tell you what the capability _is_.",
  run: (context) => Promise.resolve(countVendorNamedDomain(context)),
};
