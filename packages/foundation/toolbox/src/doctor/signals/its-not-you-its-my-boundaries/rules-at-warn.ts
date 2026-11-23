/**
 * Lint rules the configuration resolves at `warn`: ceiling 0.
 *
 * A rule at `warn` is a rule that has already lost. It prints, the build stays
 * green, and after the third run nobody reads the line — the rule is still in
 * the configuration, so the repository still says it holds it, and nothing it
 * forbids is actually forbidden. That is the failure twice over: no boundary
 * where one is claimed, and enforcement that cannot say what it stopped, which
 * is why this reading is reported under both issues.
 *
 * It reads the same four probe files as `lint-rules`, through the same
 * scanner, and keys each finding `<scope>:<rule>` so the fix names the scope
 * to change and the rule to raise or drop. Where the probes cannot be resolved
 * it reads nothing, exactly as the floor beside it does.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { resolveLintScopes, rulesAtSeverity } from "../scanners/lint-configuration.js";

function countRulesAtWarn(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const scope of resolveLintScopes(context)) {
    for (const rule of rulesAtSeverity(scope, "warn")) {
      readings.set(`${scope.scope}:${rule}`, {
        value: 1,
        evidence: [{ path: scope.path, name: rule }],
      });
    }
  }
  return readings;
}

export const rulesAtWarnSignal: DoctorSignal = {
  id: "rules-at-warn",
  issue: "its-not-you-its-my-boundaries",
  alsoUnder: ["dad-has-issues-too"],
  question: "Does `eslint --print-config` resolve any rule at `warn`?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "A warning at `warn` that everybody learned to scroll past.",
  run: (context) => Promise.resolve(countRulesAtWarn(context)),
};
