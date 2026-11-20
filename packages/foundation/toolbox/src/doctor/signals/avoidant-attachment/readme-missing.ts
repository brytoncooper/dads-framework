/**
 * Declared packages with no README: ceiling 0.
 *
 * A README is the first thing a consumer reads and the only part of a package
 * that has to make sense before anything is installed. A package that ships a
 * manifest and no README hands its first consumer nothing to program against,
 * which is the whole of avoidant attachment.
 *
 * The question is asked of a declared package that carries a `package.json`,
 * for two reasons. The manifest is what a registry installs and the README is
 * what it renders beside it, so the two travel together; and a declared root
 * with no manifest is a directory the project file has named — a crate, a
 * scripts tree — whose documentation convention is not this one. `dad doctor`
 * does not invent a convention for an ecosystem it is not reading.
 *
 * Every in-scope package gets a key, zeros included, so a package that loses
 * its README reports as being over rather than as a key nothing measures.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  declaredPackages,
  pathInPackage,
} from "../scanners/text-declared-packages.js";

const MANIFEST_FILE = "package.json";
const README_FILE = "README.md";

function countPackagesWithoutReadme(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const declared of declaredPackages(context)) {
    if (!context.exists(pathInPackage(declared, MANIFEST_FILE))) continue;
    const readme = pathInPackage(declared, README_FILE);
    readings.set(declared.name, {
      value: context.exists(readme) ? 0 : 1,
      evidence: [{ path: readme, name: declared.name }],
    });
  }
  return readings;
}

export const readmeMissingSignal: DoctorSignal = {
  id: "readme-missing",
  issue: "avoidant-attachment",
  question:
    "Does any package lack a README, or carry one outside the template?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You will not be known, so you keep no contracts.",
  run: (context) => Promise.resolve(countPackagesWithoutReadme(context)),
};
