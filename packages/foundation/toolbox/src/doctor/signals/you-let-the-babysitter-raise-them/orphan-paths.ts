/**
 * Source `dad orient` cannot hand to an owner: ceiling 0.
 *
 * `dad orient <path>` answers with the package that owns it, its
 * responsibility, and the verification it must pass. A file under no declared
 * root gets no answer, and an agent asking where it belongs is told nothing —
 * which is exactly the condition the essay describes, because an agent does
 * what the house allows and this file is a place the house has not spoken
 * about.
 *
 * The scope is source: the roots and the extensions a line budget already
 * applies to. A README at the top of the repository is not orphaned, it is a
 * README; a `.ts` file under `packages/` that no package claims is a room
 * nobody was given.
 *
 * Ownership is longest-root-first, the same rule `orientProjectPath` uses, so
 * this signal answers exactly the question the command answers. Without a
 * `dads.project.json` there are no owners to fail to find, and the signal
 * reports that it was not measured.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { readPackageGraph } from "../scanners/package-graph.js";
import { SOURCE_EXTENSIONS, SOURCE_ROOTS } from "../scanners/source-classification.js";

function isOwnableSource(path: string): boolean {
  return (
    SOURCE_ROOTS.some((root) => path.startsWith(root)) &&
    SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
  );
}

function countUnownedSource(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  if (!graph.declared) return readings;
  const roots = graph.packages.map((declared) => declared.root);
  for (const path of context.files()) {
    if (!isOwnableSource(path)) continue;
    const owned = roots.some((root) => path === root || path.startsWith(`${root}/`));
    readings.set(path, { value: owned ? 0 : 1, evidence: [{ path }] });
  }
  return readings;
}

export const orphanPathsSignal: DoctorSignal = {
  id: "orphan-paths",
  issue: "you-let-the-babysitter-raise-them",
  question: "Is there a file `dad orient` cannot assign to an owning package?",
  reads: "packages",
  unit: "files",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "He does exactly what the house allows.",
  run: (context) => Promise.resolve(countUnownedSource(context)),
};
