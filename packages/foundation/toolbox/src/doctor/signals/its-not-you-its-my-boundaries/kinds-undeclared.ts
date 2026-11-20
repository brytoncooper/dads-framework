/**
 * A package the declaration says nothing about: ceiling 0.
 *
 * The kind matrix is the only rule that governs what a package may reach, and a
 * package with no kind is exempt from it. That exemption is invisible: nothing
 * fails, no edge is forbidden, and the package quietly becomes the one place
 * anything may be wired to anything.
 *
 * Two shapes count. A workspace package — a `package.json` under one of the
 * globs the root manifest lists — that `dads.project.json` never names has no
 * kind at all. A declared package that omits `kind` has none either. An
 * unrecognized kind is not counted here: `kind-inversions` refuses to measure
 * the whole graph when it meets one, and a refusal with the offending name in
 * it is louder than a count of one.
 *
 * Without a `dads.project.json` there is nothing to be undeclared against, and
 * the signal reports that it was not measured. A repository that has not
 * adopted Dads has not failed this test; it has not taken it.
 */

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import {
  manifestRootOf,
  readPackageGraph,
  type PackageManifestFacts,
} from "../scanners/package-graph.js";

const ROOT_MANIFEST = "package.json";

/** A workspace glob, with `*` standing for one path segment. */
function matchesGlob(glob: string, path: string): boolean {
  const pattern = glob
    .split("/")
    .map((segment) => (segment === "*" ? "[^/]+" : escapeSegment(segment)))
    .join("/");
  return new RegExp(`^${pattern}$`).test(path);
}

function escapeSegment(segment: string): string {
  return segment.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readWorkspaceGlobs(context: DoctorContext): readonly string[] {
  if (!context.exists(ROOT_MANIFEST)) return [];
  try {
    const parsed: unknown = JSON.parse(context.read(ROOT_MANIFEST));
    const globs: unknown = isRecord(parsed) ? parsed["workspaces"] : undefined;
    return isUnknownArray(globs) ? globs.filter(isString) : [];
  } catch {
    return [];
  }
}

/**
 * True when the globs include the directory and no negation takes it back.
 *
 * A root manifest that lists no workspaces is not a workspace with no packages;
 * it is a workspace that has not said which they are. Every manifest in the
 * tree is one then, which is the same rule the context uses when nothing is
 * declared at all.
 */
function isWorkspaceDirectory(
  globs: readonly string[],
  directory: string,
): boolean {
  if (globs.length === 0) return true;
  const included = globs.some(
    (glob) => !glob.startsWith("!") && matchesGlob(glob, directory),
  );
  if (!included) return false;
  return !globs.some(
    (glob) => glob.startsWith("!") && matchesGlob(glob.slice(1), directory),
  );
}

function undeclaredWorkspaceManifests(
  context: DoctorContext,
  manifests: readonly PackageManifestFacts[],
  declaredRoots: ReadonlySet<string>,
): readonly PackageManifestFacts[] {
  const globs = readWorkspaceGlobs(context);
  return manifests.filter((manifest) => {
    const directory = manifestRootOf(manifest);
    if (directory.length === 0 || declaredRoots.has(directory)) return false;
    return isWorkspaceDirectory(globs, directory);
  });
}

function countUndeclaredKinds(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  if (!graph.declared) return readings;
  const roots = new Set(graph.packages.map((declared) => declared.root));
  for (const declared of graph.packages) {
    readings.set(declared.name, {
      value: declared.kind === undefined ? 1 : 0,
      evidence:
        declared.kind === undefined
          ? [{ path: declared.root, name: declared.name }]
          : [],
    });
  }
  for (const manifest of undeclaredWorkspaceManifests(
    context,
    graph.manifests,
    roots,
  )) {
    readings.set(manifest.name ?? manifest.path, {
      value: 1,
      evidence: [{ path: manifest.path, name: manifest.name ?? "" }],
    });
  }
  return readings;
}

export const kindsUndeclaredSignal: DoctorSignal = {
  id: "kinds-undeclared",
  issue: "its-not-you-its-my-boundaries",
  question: "Does any package declare no `kind`?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "A boundary is not a vibe. It is a place a change has to stop.",
  run: (context) => Promise.resolve(countUndeclaredKinds(context)),
};
