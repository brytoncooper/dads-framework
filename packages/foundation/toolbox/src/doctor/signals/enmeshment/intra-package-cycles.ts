/**
 * An import cycle inside a package: ceiling 0.
 *
 * A cycle is two files that were never really two files. Neither can be read,
 * moved, tested, or deleted without the other, the initialisation order
 * becomes something you learn by being burned, and the package has no order in
 * which a reader can meet it.
 *
 * The reading is per package, and the number is how many imports close a
 * cycle — the edge a depth-first walk finds pointing back at a module it is
 * still inside. Every one of them is an import somebody can delete or invert,
 * so the evidence points at the import rather than at the cycle, which nobody
 * can act on as a whole.
 *
 * Only production modules are walked, and only relative imports that survive
 * compilation. A package that reaches its own modules through its published
 * name has a different problem; a test that imports the module under test is
 * not a cycle; and an `import type` that closes a loop is erased before
 * anything runs, so it cannot put a module in the wrong initialisation order
 * and is not counted.
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
  isProductionModule,
  moduleImports,
  resolveRelativeImport,
  type DoctorModule,
} from "../scanners/typescript-program.js";

type Edge = {
  readonly to: string;
  readonly evidence: SignalEvidence;
};

const VISITING = 1;
const VISITED = 2;

function edgesFrom(
  module: DoctorModule,
  inPackage: ReadonlySet<string>,
): readonly Edge[] {
  const edges: Edge[] = [];
  for (const imported of moduleImports(module)) {
    if (imported.typeOnly) continue;
    const target = resolveRelativeImport(module.path, imported.specifier).find(
      (candidate) => inPackage.has(candidate),
    );
    if (target === undefined) continue;
    edges.push({
      to: target,
      evidence: evidenceAt(module, imported.node, `imports ${target}`),
    });
  }
  return edges;
}

/** Every import that points back at a module the walk is still inside. */
function backEdges(
  graph: ReadonlyMap<string, readonly Edge[]>,
): readonly SignalEvidence[] {
  const state = new Map<string, number>();
  const found: SignalEvidence[] = [];
  const walk = (from: string): void => {
    state.set(from, VISITING);
    for (const edge of graph.get(from) ?? []) {
      const seen = state.get(edge.to);
      if (seen === VISITING) found.push(edge.evidence);
      else if (seen !== VISITED) walk(edge.to);
    }
    state.set(from, VISITED);
  };
  for (const from of graph.keys()) {
    if (state.get(from) === undefined) walk(from);
  }
  return found;
}

function countIntraPackageCycles(context: DoctorContext): SignalReadings {
  const byPackage = new Map<string, DoctorModule[]>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    byPackage.set(module.packageRoot, [
      ...(byPackage.get(module.packageRoot) ?? []),
      module,
    ]);
  }

  const readings = new Map<string, SignalReading>();
  for (const [root, modules] of byPackage) {
    const inPackage = new Set(modules.map((module) => module.path));
    const graph = new Map<string, readonly Edge[]>(
      modules.map((module) => [module.path, edgesFrom(module, inPackage)]),
    );
    const found = backEdges(graph);
    readings.set(root, { value: found.length, evidence: found });
  }
  return readings;
}

export const intraPackageCyclesSignal: DoctorSignal = {
  id: "intra-package-cycles",
  issue: "enmeshment",
  question: "Is there an import cycle inside a package?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Nobody in this family has a door.",
  run: (context) => Promise.resolve(countIntraPackageCycles(context)),
};
