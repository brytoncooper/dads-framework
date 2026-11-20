/**
 * A vendor reached from outside the package that keeps it: ceiling 0.
 *
 * A vendor enters a workspace through one package, and that package says so in
 * its manifest or in its allowed dependencies. Every other package is supposed
 * to speak to the capability, not to the vendor. So the question is not "does
 * anybody import this vendor" — somebody must — but "does anybody import it who
 * never said they would".
 *
 * A module nobody declares is not measured here. An import of a package that
 * appears in no manifest is a different failure — an undeclared dependency —
 * and answering it from this signal would turn one missing manifest line into a
 * vendor crossing it is not.
 *
 * The key is the package and the number is how many vendors it reached around.
 * Every package gets one, zero included, so a workspace that holds the line
 * reads as holding it rather than as never having been asked.
 */

import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import type { DoctorContext } from "../../doctor-context.js";
import {
  declaresModule,
  readPackageGraph,
  vendorImports,
  type GraphPackage,
  type PackageGraph,
} from "../scanners/package-graph.js";

function keepersOf(graph: PackageGraph, module: string): readonly string[] {
  return graph.packages
    .filter((declared) => declaresModule(declared, module))
    .map((declared) => declared.name);
}

function crossingsBy(
  graph: PackageGraph,
  declared: GraphPackage,
): SignalReading {
  const crossings = vendorImports(graph, declared).filter((entry) => {
    const module = entry.module ?? "";
    return (
      !declaresModule(declared, module) && keepersOf(graph, module).length > 0
    );
  });
  return {
    value: crossings.length,
    evidence: crossings.map((entry) => ({
      path: entry.path,
      line: entry.line,
      name: entry.specifier,
    })),
  };
}

function countCrossings(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  for (const declared of graph.packages) {
    readings.set(declared.name, crossingsBy(graph, declared));
  }
  return readings;
}

export const vendorOutsideAdapterSignal: DoctorSignal = {
  id: "vendor-outside-adapter",
  issue: "anxious-attachment",
  question:
    "Is a vendor module imported outside the integration package declaring it?",
  reads: "packages",
  unit: "files",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "We do not keep secrets. Except in the integration package. That is what it is for. That is the one place. Do not test him.",
  run: (context) => Promise.resolve(countCrossings(context)),
};
