/**
 * Publishable packages with no surface report: report-only.
 *
 * A package that declares `publishConfig` has said it will be installed by
 * somebody who is not in this repository. What that somebody compiles against
 * is the emitted declarations, and the only way a change to them becomes
 * visible in review is a report committed beside the package: one line per
 * export, so a widened parameter or a type that quietly stopped being exported
 * is a diff rather than a surprise in a consumer's build.
 *
 * The question is asked of a package that publishes types. A package whose
 * `exports` name a binary has no type surface to report, and asking it for one
 * would report a missing file that could never be written. So the manifest has
 * to name a `.d.ts` somewhere before the reading applies — which is the same
 * rule a surface generator uses to decide what it can read.
 *
 * It is report-only in both profiles because the report file's name is a
 * repository's convention rather than Dad's. What the plan holds is the count.
 */

import { isRecord, isString } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";

const MANIFEST_SUFFIX = "package.json";
const REPORT_FILE = "api-report.md";
const DECLARATION_SUFFIX = ".d.ts";

/** True when the manifest names a TypeScript declaration a consumer compiles. */
export function publishesTypes(manifest: Record<string, unknown>): boolean {
  return namesADeclaration(manifest["types"] ?? manifest["typings"] ?? manifest["exports"]);
}

function namesADeclaration(value: unknown): boolean {
  if (isString(value)) return value.endsWith(DECLARATION_SUFFIX);
  if (Array.isArray(value)) return value.some(namesADeclaration);
  if (!isRecord(value)) return false;
  return Object.values(value).some(namesADeclaration);
}

function manifestPaths(context: DoctorContext): readonly string[] {
  return context.files().filter((path) => path === MANIFEST_SUFFIX || path.endsWith(`/${MANIFEST_SUFFIX}`));
}

function readPackageManifest(context: DoctorContext, path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(context.read(path));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function countPackagesWithoutSurface(context: DoctorContext): SignalReadings {
  const tracked = new Set(context.files());
  const readings = new Map<string, SignalReading>();
  for (const path of manifestPaths(context)) {
    const manifest = readPackageManifest(context, path);
    if (manifest === undefined) continue;
    if (manifest["publishConfig"] === undefined) continue;
    if (!publishesTypes(manifest)) continue;
    const name: unknown = manifest["name"];
    const report = `${path.slice(0, -MANIFEST_SUFFIX.length)}${REPORT_FILE}`;
    readings.set(isString(name) ? name : path, {
      value: tracked.has(report) ? 0 : 1,
      evidence: [{ path: report }],
    });
  }
  return readings;
}

export const packagesWithoutSurfaceSignal: DoctorSignal = {
  id: "packages-without-surface",
  issue: "failure-to-launch",
  question: "Does a package declaring `publishConfig` have no api report?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  sentence: "Four years. Still lives in the controller. Still no public contract. Still “figuring things out.”",
  run: (context) => Promise.resolve(countPackagesWithoutSurface(context)),
};
