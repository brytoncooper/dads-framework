/**
 * How many packages a change to this one can reach: report-only.
 *
 * There is no right number of importers, which is why this signal carries no
 * threshold in either profile. It is the number a reader needs before they
 * argue about any of the others: a copied type in a package nothing imports is
 * a mess, and the same copy in a package eleven others import is a Tuesday
 * outage. The plan's own example prints it that way — a package name and its
 * importer count — and Dad does not judge it.
 *
 * The edges are the ones the text shows, not the ones the manifest allows: an
 * allowed dependency nobody imports has no blast radius, and this is the only
 * signal in the lane that asks what the code actually does rather than what the
 * declaration permits. Every package gets a key, zero included, so a package
 * losing its last importer reads as the change it is.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { importersOf, readPackageGraph } from "../scanners/package-graph.js";

function countImporters(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  for (const declared of graph.packages) {
    const importers = importersOf(graph, declared.name);
    readings.set(declared.name, {
      value: importers.length,
      evidence: importers.map((importer) => ({
        path: importer.root,
        name: importer.name,
      })),
    });
  }
  return readings;
}

export const blastRadiusSignal: DoctorSignal = {
  id: "blast-radius",
  issue: "anxious-attachment",
  question: "How many packages import each package, largest first?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  sentence: "Your blast radius is a cry for help.",
  run: (context) => Promise.resolve(countImporters(context)),
};
