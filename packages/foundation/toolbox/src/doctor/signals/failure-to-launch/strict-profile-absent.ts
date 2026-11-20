/**
 * An application with routes that asserts no strict profile: report, then
 * ceiling 0.
 *
 * A profile is where an application says out loud which rules it has agreed
 * to. Without one, every rule in this document is a preference somebody may
 * have followed, and the only way to find out is to read the routes. The
 * assertion is also the thing that fails when the rules tighten, which is the
 * only reason tightening them ever reaches an application.
 *
 * The subject is an application package that has routes at all — an
 * application with none has nothing to assert about — and the reading is
 * whether any module in it reaches for a strict profile. An application that
 * does reads zero and stays on the list, so the line says how many of them
 * there are rather than going quiet.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  isProductionModule,
  moduleImports,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const APPLICATION_ROOT = "apps/";
const ROUTE_PATH = /route/i;
const STRICT_PROFILE = /profile-strict|strict-profile/;
const HTTP_PACKAGE = /(?:^|\/)http(?:-|$)/;

function hasRoutes(module: DoctorModule): boolean {
  if (ROUTE_PATH.test(module.path)) return true;
  return moduleImports(module).some((imported) =>
    HTTP_PACKAGE.test(imported.specifier),
  );
}

function assertsStrictProfile(module: DoctorModule): boolean {
  return moduleImports(module).some((imported) =>
    STRICT_PROFILE.test(imported.specifier),
  );
}

function countMissingProfiles(context: DoctorContext): SignalReadings {
  const routed = new Map<string, boolean>();
  const asserted = new Set<string>();
  for (const module of context.program().modules) {
    if (!module.path.startsWith(APPLICATION_ROOT)) continue;
    if (!isProductionModule(module.path)) continue;
    if (assertsStrictProfile(module)) asserted.add(module.packageRoot);
    const found = routed.get(module.packageRoot) ?? false;
    routed.set(module.packageRoot, found || hasRoutes(module));
  }

  const readings = new Map<string, SignalReading>();
  for (const [root, hasRoute] of routed) {
    if (!hasRoute) continue;
    readings.set(root, {
      value: asserted.has(root) ? 0 : 1,
      evidence: [{ path: root, name: "no strict-profile assertion" }],
    });
  }
  return readings;
}

export const strictProfileAbsentSignal: DoctorSignal = {
  id: "strict-profile-absent",
  issue: "failure-to-launch",
  question: "Does an application with routes make no strict-profile assertion?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "You don’t need another reorganization. You need a strict profile. Same thing as therapy, except the strict profile can make you run the tests.",
  run: (context) => Promise.resolve(countMissingProfiles(context)),
};
