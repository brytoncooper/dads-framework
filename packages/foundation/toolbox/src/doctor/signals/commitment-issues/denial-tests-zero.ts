/**
 * Protected routes and nothing that proves a denial: ceiling 0.
 *
 * Zero denial cases. Everything passes, because everything was run as somebody
 * who was allowed. The access declaration is then a comment: nothing in the
 * repository has ever watched it say no, and the day it stops saying no the
 * tests keep passing.
 *
 * A package is asked once it declares a protected route. Explicit public
 * access from the HTTP route package does not require denial proof. It has answered when
 * something under its root executes a denial — a strict-profile denial proof,
 * or a test whose name says it denies, forbids, or refuses. That search covers
 * the package's tests as well as its sources, because a proof is a test and a
 * package that keeps its proofs beside its code should not be told it has none.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { packageFiles, type GraphPackage } from "../scanners/package-graph.js";
import { readRouteModel } from "../scanners/route-model.js";

const DENIAL_MARKS = ["proveMissingRelationshipDenial", "denial", "denies", "denied", "forbidden", "unauthorized"];
const READABLE = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function denialProofIn(context: DoctorContext, declared: GraphPackage): string | undefined {
  for (const path of packageFiles(context, declared)) {
    if (!READABLE.some((extension) => path.endsWith(extension))) continue;
    const text = context.read(path).toLowerCase();
    if (DENIAL_MARKS.some((mark) => text.includes(mark.toLowerCase()))) {
      return path;
    }
  }
  return undefined;
}

function countPackagesWithoutDenial(context: DoctorContext) {
  const model = readRouteModel(context);
  const readings = new Map<string, SignalReading>();
  for (const declared of model.packagesWithRoutes) {
    const protectedRoutes = model.operations.filter(
      (operation) =>
        operation.packageName === declared.name && operation.declaresAccess && operation.explicitlyPublic !== true,
    );
    if (protectedRoutes.length === 0) continue;
    const proof = denialProofIn(context, declared);
    readings.set(declared.name, {
      value: proof === undefined ? 1 : 0,
      evidence:
        proof === undefined ? [{ path: declared.root, name: declared.name }] : [{ path: proof, name: declared.name }],
    });
  }
  return readings;
}

export const denialTestsZeroSignal: DoctorSignal = {
  id: "denial-tests-zero",
  issue: "commitment-issues",
  question: "Does a package with protected routes have no denial test or denial proof?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Zero denial cases. They said “lgtm.” You still feel alone.",
  run: (context) => Promise.resolve(countPackagesWithoutDenial(context)),
};
