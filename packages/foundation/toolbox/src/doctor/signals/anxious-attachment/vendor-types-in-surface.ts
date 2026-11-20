/**
 * A foreign type named in a package's exported surface: ceiling 0.
 *
 * This is the reading that tells a wrapper from a boundary. A package may
 * import whatever its declaration allows; what it may not do is hand the
 * vendor's vocabulary to its consumers, because then every consumer depends on
 * the vendor too and the package that was supposed to hold the line is just a
 * place the name passes through.
 *
 * The surface is read from the exported declarations of the source rather than
 * from an emitted `.d.ts`, so the answer does not depend on whether the
 * workspace has been built — the emitted file says the same thing, later, and
 * only for a package somebody remembered to compile.
 *
 * A package is judged against its own declaration: the name it publishes under
 * and the dependencies it says it allows. A repository with no
 * `dads.project.json` has declared nothing to be judged against, so this
 * reports that it was not measured rather than calling every import foreign.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  evidenceAt,
  exportedStatements,
  importedBindings,
  isLocalSpecifier,
  isProductionModule,
  leftmostTypeName,
  packageOfSpecifier,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const PROJECT_FILE = "dads.project.json";

/** The name a node uses as a type, when it uses one. */
function referencedTypeName(node: ts.Node): string | undefined {
  if (ts.isTypeReferenceNode(node)) return leftmostTypeName(node.typeName);
  if (
    ts.isExpressionWithTypeArguments(node) &&
    ts.isIdentifier(node.expression)
  ) {
    return node.expression.text;
  }
  return undefined;
}

function foreignNames(
  module: DoctorModule,
  allowed: ReadonlySet<string>,
  own: string,
): readonly SignalEvidence[] {
  const bindings = importedBindings(module);
  const found: SignalEvidence[] = [];
  const inspect = (node: ts.Node): void => {
    const name = referencedTypeName(node);
    const specifier = name === undefined ? undefined : bindings.get(name);
    if (specifier === undefined || isLocalSpecifier(specifier)) return;
    const owner = packageOfSpecifier(specifier);
    if (owner === own || allowed.has(owner)) return;
    found.push(evidenceAt(module, node, `${name ?? owner} from ${specifier}`));
  };
  for (const statement of exportedStatements(module)) {
    visitNodes(statement, inspect);
  }
  return found;
}

function countForeignSurface(context: DoctorContext): SignalReadings {
  if (!context.exists(PROJECT_FILE)) return new Map<string, SignalReading>();
  const modules = context.program().modules;
  const readings = new Map<string, SignalReading>();
  for (const declared of context.packages()) {
    const allowed = new Set(declared.allowedDependencies);
    const evidence = modules
      .filter(
        (module) =>
          module.packageRoot === declared.root &&
          isProductionModule(module.path),
      )
      .flatMap((module) => foreignNames(module, allowed, declared.name));
    readings.set(declared.name, { value: evidence.length, evidence });
  }
  return readings;
}

export const vendorTypesInSurfaceSignal: DoctorSignal = {
  id: "vendor-types-in-surface",
  issue: "anxious-attachment",
  alsoUnder: ["the-paper-wall"],
  question:
    "Does an emitted `.d.ts` name a type from outside its package and its allowed dependencies?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "Dad is not angry you used the vendor type. He is disappointed you introduced it to the children as “Uncle Request.”",
  run: (context) => Promise.resolve(countForeignSurface(context)),
};
