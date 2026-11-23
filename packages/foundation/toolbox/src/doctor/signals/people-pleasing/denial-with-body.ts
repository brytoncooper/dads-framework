/**
 * A denial that explains itself: ceiling 0.
 *
 * The envelope already carries a code and a message. A denial that declares a
 * payload on top of that — a shape, a details object, the fields that failed —
 * is the codebase explaining itself to a caller it has just told it will not
 * answer. Every field in it is a fact about a resource the caller was not
 * allowed to know exists, and none of them can ever be removed again.
 *
 * A denial is an error declaration whose status is 401, 403 or 404. The reading
 * finds one in the sources of the packages that declare routes, then reads the
 * object literal it sits in — bracket depth, over a skeleton with the strings
 * emptied — and asks whether that same literal declares a payload. Proximity
 * alone would count the next error in the file; the literal is the boundary the
 * declaration itself drew.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading } from "../../doctor-signal.js";
import { readRouteModel } from "../scanners/route-model.js";
import { readCodeSkeleton, type SkeletonLine } from "../scanners/top-level-declarations.js";

const DENIAL_STATUS = /\bstatus\s*:\s*(?:401|403|404)\b/;
const BODY_PROPERTY = /^(?:shape|body|data|details|payload|fields|errors)\s*:/;

/** The first line at or after `from` whose depth leaves the literal. */
function literalEnd(skeleton: readonly SkeletonLine[], from: number, depth: number): number {
  for (let index = from; index < skeleton.length; index += 1) {
    const line = skeleton[index];
    if (line !== undefined && line.endDepth < depth) return index;
  }
  return skeleton.length;
}

function literalStart(skeleton: readonly SkeletonLine[], from: number, depth: number): number {
  for (let index = from; index >= 0; index -= 1) {
    const line = skeleton[index];
    if (line !== undefined && line.startDepth < depth) return index;
  }
  return 0;
}

/** True when the object literal holding this line also declares a payload. */
function carriesBody(skeleton: readonly SkeletonLine[], at: number, depth: number): boolean {
  const from = literalStart(skeleton, at, depth);
  const to = literalEnd(skeleton, at, depth);
  for (let index = from; index <= to && index < skeleton.length; index += 1) {
    const line = skeleton[index];
    if (line === undefined || line.startDepth !== depth) continue;
    if (BODY_PROPERTY.test(line.text.trim())) return true;
  }
  return false;
}

function denialsWithBodyIn(context: DoctorContext, paths: readonly string[]): readonly SignalEvidence[] {
  const found: SignalEvidence[] = [];
  for (const path of paths) {
    const skeleton = readCodeSkeleton(context.read(path));
    for (const [index, line] of skeleton.entries()) {
      if (!DENIAL_STATUS.test(line.text)) continue;
      if (!carriesBody(skeleton, index, line.startDepth)) continue;
      found.push({ path, line: index + 1, name: line.text.trim() });
    }
  }
  return found;
}

function countDenialsWithBody(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  for (const declared of readRouteModel(context).packagesWithRoutes) {
    const evidence = denialsWithBodyIn(context, declared.sources);
    readings.set(declared.name, { value: evidence.length, evidence });
  }
  return readings;
}

export const denialWithBodySignal: DoctorSignal = {
  id: "denial-with-body",
  issue: "people-pleasing",
  question: "Does a denial response carry a message beyond the envelope?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You return 403 with a paragraph so the unauthorized caller will not think you’re rude.",
  run: (context) => Promise.resolve(countDenialsWithBody(context)),
};
