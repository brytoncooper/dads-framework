/**
 * Exported declarations with nothing written above them: report, then 10%.
 *
 * A consumer reads the name and the type. Everything else — what the thing is
 * for, when to reach for it, what it will refuse to do — is either in a
 * sentence above the declaration or it is in somebody's head. The share is per
 * package because a package is the unit a consumer adopts: one undocumented
 * helper is a gap, and a package where most of the surface is undocumented is
 * a package that hands you nothing to program against.
 *
 * Report-only under `standard`, and 10% under `strict`, so the packages this
 * emits are the ones already at or over that ceiling. A distribution of
 * healthy shares would read as something seen on every repository, and a
 * signal that is always partly on is a signal nobody reads.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  declaredNames,
  evidenceAt,
  exportedStatements,
  hasDocComment,
  isProductionModule,
  type DoctorModule,
} from "../scanners/typescript-program.js";

/** The share `strict` refuses, which is also the share worth reporting. */
const CEILING = 10;

type SurfaceCount = {
  declarations: number;
  readonly undocumented: SignalEvidence[];
};

function readSurface(module: DoctorModule, counted: SurfaceCount): void {
  for (const statement of exportedStatements(module)) {
    const names = declaredNames(statement);
    if (names.length === 0) continue;
    counted.declarations += 1;
    if (hasDocComment(module, statement)) continue;
    counted.undocumented.push(evidenceAt(module, statement, names[0]));
  }
}

function countUndocumentedExports(context: DoctorContext): SignalReadings {
  const perPackage = new Map<string, SurfaceCount>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    const counted = perPackage.get(module.packageRoot) ?? {
      declarations: 0,
      undocumented: [],
    };
    readSurface(module, counted);
    perPackage.set(module.packageRoot, counted);
  }

  const readings = new Map<string, SignalReading>();
  for (const [root, counted] of perPackage) {
    if (counted.declarations === 0) continue;
    const share = Math.round(
      (counted.undocumented.length / counted.declarations) * 100,
    );
    if (share < CEILING) continue;
    readings.set(root, { value: share, evidence: counted.undocumented });
  }
  return readings;
}

export const undocumentedExportsSignal: DoctorSignal = {
  id: "undocumented-exports",
  issue: "avoidant-attachment",
  question:
    "Is the share of exported declarations with no doc comment above the profile's threshold?",
  reads: "typescript",
  unit: "percent",
  direction: "ceiling",
  thresholds: { standard: null, strict: CEILING },
  sentence:
    "The first consumer asks a question and you have nothing to hand them except a raw array and “docs coming soon.”",
  run: (context) => Promise.resolve(countUndocumentedExports(context)),
};
