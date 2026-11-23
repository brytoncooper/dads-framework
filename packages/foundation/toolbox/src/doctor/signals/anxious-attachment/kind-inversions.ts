/**
 * Dependency edges the kind matrix forbids: ceiling 0.
 *
 * A package's `kind` says what it is allowed to know about. `core` is the
 * layer everything else is written against, so it may only reach other `core`;
 * an `adapter` exists to bind one vendor to `core`, so it reaches `core` and
 * its own third party and never another adapter; a `binding` binds one more
 * library to an adapter it names; an `edge` composes core packages into a
 * boundary; a `profile` is allowed to reach across the layers because
 * assembling them is what a profile is; `tooling` may use the framework and
 * other tooling but not a concrete backend; `composition` is an application or
 * a fixture, the one place where anything may be wired to anything.
 *
 * Third-party dependencies are not edges here. This signal asks only whether
 * the shape of the workspace graph is one the kinds allow.
 *
 * A key is emitted for every declared edge, allowed ones at zero included, so
 * an edge that is removed or made legal reads as being at the ceiling. An
 * unknown or missing `kind` throws instead of counting as zero: a package that
 * forgets to declare what it is would otherwise be exempt from the only rule
 * that governs it.
 */

import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";

import { readSourceBindings } from "../scanners/source-bindings.js";

const PROJECT_FILE = "dads.project.json";

const ALLOWED_TARGET_KINDS = new Map<string, readonly string[]>([
  ["core", ["core", "artifact"]],
  ["adapter", ["core"]],
  ["integration", ["core"]],
  ["binding", ["core", "adapter", "integration"]],
  ["edge", ["core", "edge"]],
  ["profile", ["core", "adapter", "integration", "binding", "edge"]],
  ["tooling", ["core", "tooling", "artifact"]],
  [
    "composition",
    [
      "core",
      "adapter",
      "integration",
      "binding",
      "edge",
      "profile",
      "tooling",
      "composition",
      "application",
      "artifact",
    ],
  ],
  [
    "application",
    [
      "core",
      "adapter",
      "integration",
      "binding",
      "edge",
      "profile",
      "tooling",
      "composition",
      "application",
      "artifact",
    ],
  ],
  ["artifact", []],
]);

function readKinds(packages: readonly DoctorPackage[]): ReadonlyMap<string, string> {
  const kinds = new Map<string, string>();
  for (const declared of packages) {
    const kind = declared.kind;
    if (kind === undefined || !ALLOWED_TARGET_KINDS.has(kind)) {
      throw new Error(
        `${PROJECT_FILE}: package "${declared.name}" declares kind ${JSON.stringify(kind)}; expected one of ${[...ALLOWED_TARGET_KINDS.keys()].join(", ")}`,
      );
    }
    kinds.set(declared.name, kind);
  }
  return kinds;
}

function countForbiddenEdges(context: DoctorContext): SignalReadings {
  if (!context.exists(PROJECT_FILE)) return new Map();
  const packages = context.packages();
  const kinds = readKinds(packages);
  const readings = new Map<string, SignalReading>();
  for (const declared of packages) {
    const bindings = readSourceBindings(context, declared);
    const depsInBindings = new Set(bindings.flatMap((scope) => scope.dependencies));
    recordEdges(
      readings,
      kinds,
      declared.name,
      kinds.get(declared.name),
      declared.allowedDependencies.filter((name) => !depsInBindings.has(name)),
    );
    for (const binding of bindings) {
      recordEdges(readings, kinds, `${declared.name}/${binding.name}`, "binding", binding.dependencies);
    }
  }
  return readings;
}

function recordEdges(
  readings: Map<string, SignalReading>,
  kinds: ReadonlyMap<string, string>,
  owner: string,
  ownerKind: string | undefined,
  dependencies: readonly string[],
): void {
  const allowed = ALLOWED_TARGET_KINDS.get(ownerKind ?? "");
  for (const dependency of dependencies) {
    const targetKind = kinds.get(dependency);
    if (targetKind === undefined || allowed === undefined) continue;
    const edge = `${owner} -> ${dependency}`;
    readings.set(edge, {
      value: allowed.includes(targetKind) ? 0 : 1,
      evidence: [{ path: PROJECT_FILE, name: edge }],
    });
  }
}

export const kindInversionsSignal: DoctorSignal = {
  id: "kind-inversions",
  issue: "anxious-attachment",
  question: "Does any workspace dependency edge violate the kind matrix?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You cannot be left, so you merge.",
  measure: "kindMatrixViolations",
  run: (context) => Promise.resolve(countForbiddenEdges(context)),
};
