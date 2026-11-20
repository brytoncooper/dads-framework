/**
 * Error-level lint rules per scope: a floor.
 *
 * A layered lint configuration cannot be read to answer "which rules actually
 * apply here?"; `eslint --print-config` answers it for one file, and that
 * resolved answer is what gets a floor: a rule that is an error today may not
 * quietly become a warning or disappear tomorrow.
 *
 * One probe file per scope, keyed `<scope>:<rule>` with the value 1, so the
 * failure a removed rule produces names the scope and the rule. Resolving the
 * scopes is `scanners/lint-configuration.ts`, which `rules-at-warn` reads too:
 * the same four probes answer both halves of the same question, and neither is
 * worth shelling out for twice.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  resolveLintScopes,
  rulesAtSeverity,
} from "../scanners/lint-configuration.js";

function countErrorLevelRules(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const scope of resolveLintScopes(context)) {
    for (const rule of rulesAtSeverity(scope, "error")) {
      readings.set(`${scope.scope}:${rule}`, {
        value: 1,
        evidence: [{ path: scope.path, name: rule }],
      });
    }
  }
  return readings;
}

export const lintRulesSignal: DoctorSignal = {
  id: "lint-rules",
  issue: "its-not-you-its-my-boundaries",
  question: "Has any error-level lint rule disappeared or dropped to `warn`?",
  reads: "text",
  unit: "count",
  direction: "floor",
  thresholds: { standard: null, strict: null },
  sentence: "Nothing is at `warn`; a rule is an error or it is not a rule.",
  measure: "lintRules",
  run: (context) => Promise.resolve(countErrorLevelRules(context)),
};
