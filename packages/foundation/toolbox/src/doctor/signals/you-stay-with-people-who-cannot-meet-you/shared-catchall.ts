/**
 * A package named for nothing, with a fourth importer: ceiling 0.
 *
 * `shared`, `common`, `utils`, `helpers`, `misc`: a package whose name is the
 * absence of a responsibility. One or two importers is a thing waiting to be
 * named. Four is a found family — everybody has a key, nobody pays rent — and
 * from then on nothing in it can be changed without asking everyone.
 *
 * The companion draws the line at more than three, so the number is the
 * importers beyond three and the ceiling is zero: three reads zero, five reads
 * two. An importer here is a package that says it may use this one, in its
 * manifest or in its allowed dependencies, because a catchall's problem is the
 * standing permission rather than today's import. What the text actually
 * reaches is `blast-radius`, and it is deliberately the other reading.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import {
  declaredImportersOf,
  readPackageGraph,
} from "../scanners/package-graph.js";

const CATCHALL_NAMES = new Set([
  "shared",
  "common",
  "utils",
  "util",
  "helpers",
  "misc",
]);
const ALLOWED_IMPORTERS = 3;

/** True when the last segment of a package name or root says nothing. */
export function isCatchallName(name: string, root: string): boolean {
  const fromName = name.split("/").at(-1) ?? "";
  const fromRoot = root.split("/").at(-1) ?? "";
  return CATCHALL_NAMES.has(fromName) || CATCHALL_NAMES.has(fromRoot);
}

function countCatchallImporters(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  for (const declared of graph.packages) {
    if (!isCatchallName(declared.name, declared.root)) continue;
    const importers = declaredImportersOf(graph, declared.name);
    readings.set(declared.name, {
      value: Math.max(0, importers.length - ALLOWED_IMPORTERS),
      evidence: importers.map((importer) => ({
        path: importer.root,
        name: importer.name,
      })),
    });
  }
  return readings;
}

export const sharedCatchallSignal: DoctorSignal = {
  id: "shared-catchall",
  issue: "you-stay-with-people-who-cannot-meet-you",
  question:
    "Is there a package named `shared`, `common`, or `utils` with more than three importers?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "So you move in with your found family: `libs/shared`. Everybody has a key. Nobody pays rent. Something in there bites.",
  run: (context) => Promise.resolve(countCatchallImporters(context)),
};
