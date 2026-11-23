/**
 * Package READMEs no template holds: report-only in standard, ceiling 0 in
 * strict.
 *
 * The companion writes the test as "absence from the conformance list is a
 * yes", and that is what this counts. The reason it is the list rather than
 * the prose is that a template is a repository's own decision — its headings,
 * its register, its required sections — and a doctor that carried opinions
 * about what belongs in a README would fire on every repository in the world
 * for not sharing them. `docs-conformance-packages` puts a floor under the
 * list so it may never shrink; this reading names the packages the list does
 * not reach.
 *
 * A package with no README is not counted here. That is `readme-missing`, and
 * counting it twice would make one absence read as two failures.
 *
 * The question is asked of the packages another package can depend on. An
 * `artifact` is a build product and a `composition` is a root nobody imports,
 * so neither is asked for the surface documentation a consumer would read.
 */

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { declaredPackages, pathInPackage, type DeclaredPackage } from "../scanners/text-declared-packages.js";

const CONFORMANCE_FILE = "docs/readme-conformance.json";
const README_FILE = "README.md";
const UNASKED_KINDS = new Set(["artifact", "composition"]);

function heldToTemplate(context: DoctorContext): ReadonlySet<string> {
  if (!context.exists(CONFORMANCE_FILE)) return new Set();
  const parsed: unknown = JSON.parse(context.read(CONFORMANCE_FILE));
  if (!isRecord(parsed)) return new Set();
  const listed: unknown = parsed["packages"];
  if (!isUnknownArray(listed)) return new Set();
  return new Set(listed.filter(isString));
}

function isAskedForATemplate(declared: DeclaredPackage): boolean {
  return declared.kind === undefined || !UNASKED_KINDS.has(declared.kind);
}

function countReadmesOutsideTheTemplate(context: DoctorContext): SignalReadings {
  const held = heldToTemplate(context);
  const readings = new Map<string, SignalReading>();
  for (const declared of declaredPackages(context)) {
    if (!isAskedForATemplate(declared)) continue;
    const readme = pathInPackage(declared, README_FILE);
    if (!context.exists(readme)) continue;
    readings.set(declared.name, {
      value: held.has(declared.name) ? 0 : 1,
      evidence: [{ path: readme, name: declared.name }],
    });
  }
  return readings;
}

export const readmeNonconformantSignal: DoctorSignal = {
  id: "readme-nonconformant",
  issue: "avoidant-attachment",
  question: "Does any package lack a README, or carry one outside the template?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence: "It feels like independence. It is intimacy you never learned.",
  run: (context) => Promise.resolve(countReadmesOutsideTheTemplate(context)),
};
