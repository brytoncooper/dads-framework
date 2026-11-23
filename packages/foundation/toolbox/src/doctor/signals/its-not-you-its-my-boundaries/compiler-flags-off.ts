/**
 * Strictness the compiler was not asked for: ceiling 0.
 *
 * `strict` is nine settings in a trench coat and it is not the whole list.
 * Every flag below removes a way for a value to arrive as something other than
 * what its type says — an index that might not be there, an optional property
 * that might be present and undefined, a catch variable nobody narrowed. A
 * repository with them off is not less strict by a little; it is a repository
 * where the readings under daddy issues cannot mean what they say, because the
 * compiler was never asked the question the hatches suppress.
 *
 * One key per flag, present ones at zero, so the failure names the flag rather
 * than the file. A flag written `false` counts the same as a flag left out:
 * the compiler behaves identically and the reader is the only one misled.
 *
 * The file read is the one place strictness is declared. A repository that
 * splits it across a base and a root configuration is asked for the base,
 * because that is what every project in it extends.
 */

import { isRecord } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";

const CONFIGURATION_FILES = ["tsconfig.base.json", "tsconfig.json"];

/** The flags Dads declares in its base configuration and never turns off. */
export const REQUIRED_STRICTNESS = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noPropertyAccessFromIndexSignature",
  "useUnknownInCatchVariables",
  "verbatimModuleSyntax",
];

function readCompilerOptions(context: DoctorContext, path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(context.read(path));
    const options: unknown = isRecord(parsed) ? parsed["compilerOptions"] : undefined;
    return isRecord(options) ? options : undefined;
  } catch {
    return undefined;
  }
}

function countFlagsOff(context: DoctorContext): SignalReadings {
  const path = CONFIGURATION_FILES.find((candidate) => context.exists(candidate));
  if (path === undefined) return new Map();
  const options = readCompilerOptions(context, path);
  if (options === undefined) return new Map();
  const readings = new Map<string, SignalReading>();
  for (const flag of REQUIRED_STRICTNESS) {
    readings.set(flag, {
      value: options[flag] === true ? 0 : 1,
      evidence: [{ path, name: flag }],
    });
  }
  return readings;
}

export const compilerFlagsOffSignal: DoctorSignal = {
  id: "compiler-flags-off",
  issue: "its-not-you-its-my-boundaries",
  question: "Is any strictness flag from the base list missing from the compiler configuration?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You don’t have any. That’s why they’re leaving.",
  run: (context) => Promise.resolve(countFlagsOff(context)),
};
