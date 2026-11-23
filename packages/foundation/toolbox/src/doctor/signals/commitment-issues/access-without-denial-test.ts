/**
 * Access declarations nothing has watched say no: ceiling 0.
 *
 * A package that publishes an access schema has declared who may do what. The
 * declaration is only a promise until a test asks it about somebody with no
 * relationship and watches it refuse; until then the day it stops refusing is
 * a day every test still passes.
 *
 * This is the other half of `denial-tests-zero`. That signal asks a package
 * with protected routes; this one asks a package that owns access types,
 * whether or not it serves a route — a library that declares types other
 * packages check against owes the same proof.
 *
 * A package owns access types when it holds a schema the access kit generated.
 * It has answered when one of its tests is named for a denial, or says it
 * proves one: `denial`, or a subject with "no relationship". A presence check,
 * and nothing more: whether the test is a good one is a reviewer's question.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { accessArtifacts, declaredRootsOf, owningRoot } from "../scanners/access-artifacts.js";
import { isTestSource } from "../scanners/source-classification.js";

const DENIAL_NAME = /denial/i;
const DENIAL_TEXT = /no[- ]relationship|denial/i;

/** The first test under a package root that proves a denial, if any. */
function denialTestIn(context: DoctorContext, root: string): string | undefined {
  return context
    .files()
    .filter((path) => path.startsWith(`${root}/`) && isTestSource(path))
    .find((path) => DENIAL_NAME.test(path) || (context.exists(path) && DENIAL_TEXT.test(context.read(path))));
}

function countSchemaOwnersWithoutDenial(context: DoctorContext): SignalReadings {
  const roots = declaredRootsOf(context);
  const readings = new Map<string, SignalReading>();
  for (const artifact of accessArtifacts(context)) {
    const root = owningRoot(artifact, roots);
    if (readings.has(root)) continue;
    const proof = denialTestIn(context, root);
    readings.set(root, {
      value: proof === undefined ? 1 : 0,
      evidence: [{ path: proof ?? artifact }],
    });
  }
  return readings;
}

export const accessWithoutDenialTestSignal: DoctorSignal = {
  id: "access-without-denial-test",
  issue: "commitment-issues",
  question: "Does a package that publishes a generated access schema have no test proving a denial?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Zero denial cases. They said “lgtm.” You still feel alone.",
  run: (context) => Promise.resolve(countSchemaOwnersWithoutDenial(context)),
};
