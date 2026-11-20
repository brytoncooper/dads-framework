/**
 * A deprecated export that still has importers: report, then ceiling 0.
 *
 * The tag is a promise to remove something, and an importer is the reason it
 * was never removed. Both sides are comfortable: the owner has said the thing
 * is going, the consumer has not been told when, and the export is now
 * permanent with a note on it. A deprecation with no date and no migration is
 * a way of keeping everybody happy rather than of changing anything.
 *
 * The reading is one key per deprecated export that anybody still imports, and
 * the number is how many modules do. A deprecation nobody imports is not
 * emitted: that one is finished, and only the deletion is outstanding.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import type { ts } from "../scanners/typescript-program.js";
import {
  declaredNames,
  evidenceAt,
  exportedStatements,
  importedBindings,
  isProductionModule,
  packageOfSpecifier,
  resolveRelativeImport,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const DEPRECATION = ["@", "deprecated"].join("");

/** One export somebody said was going away. */
type Deprecation = {
  readonly name: string;
  readonly module: DoctorModule;
  readonly evidence: SignalEvidence;
};

function leadingText(module: DoctorModule, start: number, end: number): string {
  return module.source.text.slice(start, end);
}

function isDeprecated(module: DoctorModule, statement: ts.Statement): boolean {
  const start = statement.getFullStart();
  const end = statement.getStart(module.source);
  return leadingText(module, start, end).includes(DEPRECATION);
}

function deprecationsIn(module: DoctorModule): readonly Deprecation[] {
  const found: Deprecation[] = [];
  for (const statement of exportedStatements(module)) {
    if (!isDeprecated(module, statement)) continue;
    for (const name of declaredNames(statement)) {
      found.push({
        name,
        module,
        evidence: evidenceAt(module, statement, name),
      });
    }
  }
  return found;
}

/**
 * True when a module imports that name from the module that declared it —
 * either by the relative path, or by the name of the package that owns it.
 */
function importsDeprecation(
  importer: DoctorModule,
  deprecated: Deprecation,
  publishedAs: string | undefined,
): boolean {
  if (importer.path === deprecated.module.path) return false;
  const specifier = importedBindings(importer).get(deprecated.name);
  if (specifier === undefined) return false;
  if (
    resolveRelativeImport(importer.path, specifier).includes(
      deprecated.module.path,
    )
  ) {
    return true;
  }
  return (
    publishedAs !== undefined && packageOfSpecifier(specifier) === publishedAs
  );
}

function countStillConsumed(context: DoctorContext): SignalReadings {
  const modules = context
    .program()
    .modules.filter((module) => isProductionModule(module.path));
  const publishedAs = new Map(
    context.packages().map((declared) => [declared.root, declared.name]),
  );
  const deprecations = modules.flatMap(deprecationsIn);
  const readings = new Map<string, SignalReading>();
  for (const deprecated of deprecations) {
    const owner = publishedAs.get(deprecated.module.packageRoot);
    const importers = modules.filter((module) =>
      importsDeprecation(module, deprecated, owner),
    );
    if (importers.length === 0) continue;
    readings.set(`${deprecated.module.path} ${deprecated.name}`, {
      value: importers.length,
      evidence: [
        deprecated.evidence,
        ...importers.map((module) => ({ path: module.path })),
      ],
    });
  }
  return readings;
}

export const deprecatedStillConsumedSignal: DoctorSignal = {
  id: "deprecated-still-consumed",
  issue: "people-pleasing",
  question: "Does a deprecated export still have importers?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "Dad packed lunch: envelope, pagination, typed errors. You traded it at school for a raw array and a deprecation warning.",
  run: (context) => Promise.resolve(countStillConsumed(context)),
};
