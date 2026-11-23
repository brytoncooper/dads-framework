/**
 * An adapter with no suite two providers could run: ceiling 0.
 *
 * Dad's test of a boundary is not the folder name. It is whether the capability
 * has a suite, and whether more than one provider can be put through it. So the
 * question is asked of the capability rather than of the adapter: an adapter
 * binds a vendor to a `core` package, and that `core` package is where the
 * suite and the in-memory stand-in belong.
 *
 * An adapter is covered when the core it adapts owns a conformance suite — a
 * module under that core whose name says `conformance` — and when that suite
 * has more than one provider to be run against: another adapter of the same
 * core, or the core's own in-memory stand-in. An adapter that binds no vendor
 * is not a wrapper and is not asked: renaming one package to another is not the
 * failure this issue describes.
 *
 * Packages may instead declare a shared law and provide two direct test registrations.
 *
 * Kinds are required, so a workspace with no declaration reports that it was
 * not measured rather than deciding which of its folders was an adapter.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import {
  declaresModule,
  readPackageGraph,
  vendorImports,
  type GraphPackage,
  type PackageGraph,
} from "../scanners/package-graph.js";

import { hasExplicitWrapperConformance } from "./explicit-wrapper-conformance.js";

const CONFORMANCE_MARK = "conformance";
const STAND_IN_MARK = "in-memory";

function coresAdaptedBy(graph: PackageGraph, adapter: GraphPackage): readonly GraphPackage[] {
  return graph.packages.filter((declared) => declared.kind === "core" && declaresModule(adapter, declared.name));
}

function ownsFileNamed(context: DoctorContext, declared: GraphPackage, mark: string): boolean {
  return context.files().some((path) => path.startsWith(`${declared.root}/`) && path.includes(mark));
}

function providersOf(graph: PackageGraph, core: GraphPackage): number {
  return graph.packages.filter((declared) => declared.kind === "adapter" && declaresModule(declared, core.name)).length;
}

/** True when the capability has a suite and a second provider to run it. */
function isCovered(context: DoctorContext, graph: PackageGraph, adapter: GraphPackage): boolean {
  if (hasExplicitWrapperConformance(context, adapter.root)) return true;
  return coresAdaptedBy(graph, adapter).some((core) => {
    if (!ownsFileNamed(context, core, CONFORMANCE_MARK)) return false;
    const standIn = ownsFileNamed(context, core, STAND_IN_MARK) ? 1 : 0;
    return providersOf(graph, core) + standIn > 1;
  });
}

function countUncoveredWrappers(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  if (!graph.declared) return readings;
  for (const adapter of graph.packages) {
    if (adapter.kind !== "adapter") continue;
    const vendors = vendorImports(graph, adapter);
    if (vendors.length === 0) continue;
    readings.set(adapter.name, {
      value: isCovered(context, graph, adapter) ? 0 : 1,
      evidence: vendors.slice(0, 1).map((entry) => ({
        path: entry.path,
        line: entry.line,
        name: entry.specifier,
      })),
    });
  }
  return readings;
}

export const wrapperWithoutConformanceSignal: DoctorSignal = {
  id: "wrapper-without-conformance",
  issue: "the-paper-wall",
  question:
    "Does a package presented as an adapter, port, or boundary have no conformance suite that more than one provider runs?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Dad’s test is not the folder name. It is the stand-in.",
  run: (context) => Promise.resolve(countUncoveredWrappers(context)),
};
