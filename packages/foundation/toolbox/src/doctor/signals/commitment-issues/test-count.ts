/**
 * Tests per package: a floor.
 *
 * Nearly every other signal is a ceiling, and a ceiling rewards deleting code.
 * The suites are the net that makes deletion visible, so the net needs its own
 * ratchet: a package may gain tests and may never quietly lose them. Skipped
 * tests are not counted, because a skip is a test that stopped proving
 * anything.
 *
 * The input is a Vitest JSON report. It is a build product, not a tracked
 * file, so it is read from disk rather than from the file list, and it is
 * often absent during a fast offline run that skips the suites. An absent
 * report throws so the doctor marks this signal as not measured instead of
 * printing zero.
 */

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";

const REPORT_FILE = "node_modules/.dads/vitest-report.json";
const COUNTED = new Set(["passed", "failed"]);
const MANIFEST_NAME = "package.json";
const MANIFEST_SUFFIX = "/package.json";

/** Every declared package and manifest directory mapped to its owner name. */
function packageDirectories(context: DoctorContext): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  let hasSubManifests = false;
  for (const path of context.files()) {
    if (!path.endsWith(MANIFEST_SUFFIX)) continue;
    hasSubManifests = true;
    const directory = path.slice(0, path.length - MANIFEST_SUFFIX.length);
    const name = readSuiteOwnerName(context, path);
    if (name !== undefined) owners.set(directory, name);
  }
  for (const declared of context.packages()) {
    const directory = normalizePackageRoot(declared.root);
    owners.set(directory, declared.name);
  }
  if (!hasSubManifests && !owners.has("") && context.exists(MANIFEST_NAME)) {
    const rootName = readSuiteOwnerName(context, MANIFEST_NAME);
    if (rootName !== undefined) owners.set("", rootName);
  }
  return owners;
}

function normalizePackageRoot(root: string): string {
  const trimmed = root.replace(/\/+$/, "");
  return trimmed === "." ? "" : trimmed;
}

function readSuiteOwnerName(context: DoctorContext, path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(context.read(path));
    const name: unknown = isRecord(parsed) ? parsed["name"] : undefined;
    return isString(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The most specific package directory that contains `path`. */
function ownerOf(path: string, owners: ReadonlyMap<string, string>): string | undefined {
  let best: string | undefined;
  for (const directory of owners.keys()) {
    if (directory.length > 0 && !path.startsWith(`${directory}/`)) continue;
    if (best === undefined || directory.length > best.length) best = directory;
  }
  return best === undefined ? undefined : owners.get(best);
}

function countAssertions(suite: unknown): number {
  if (!isRecord(suite)) return 0;
  const results: unknown = suite["assertionResults"];
  if (!isUnknownArray(results)) return 0;
  return results.filter((assertion) => {
    if (!isRecord(assertion)) return false;
    const status: unknown = assertion["status"];
    return isString(status) && COUNTED.has(status);
  }).length;
}

function suitePath(suite: unknown, root: string): string {
  if (!isRecord(suite)) return "";
  const name: unknown = suite["name"];
  if (!isString(name)) return "";
  const prefix = `${root}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function countTestsPerPackage(context: DoctorContext): SignalReadings {
  if (!context.exists(REPORT_FILE)) {
    throw new Error("run npm test first");
  }
  const parsed: unknown = JSON.parse(context.read(REPORT_FILE));
  const suites: unknown = isRecord(parsed) ? parsed["testResults"] : undefined;
  if (!isUnknownArray(suites)) {
    throw new Error("invalid test report");
  }

  const owners = packageDirectories(context);
  const readings = new Map<string, SignalReading>();
  for (const suite of suites) {
    const path = suitePath(suite, context.root);
    const owner = ownerOf(path, owners);
    if (owner === undefined) continue;
    const known = readings.get(owner);
    readings.set(owner, {
      value: (known?.value ?? 0) + countAssertions(suite),
      evidence: [...(known?.evidence ?? []), { path }],
    });
  }
  return readings;
}

export const testCountSignal: DoctorSignal = {
  id: "test-count",
  issue: "commitment-issues",
  question: "Has any package's passing test count fallen below its recorded floor?",
  reads: "text",
  unit: "count",
  direction: "floor",
  thresholds: { standard: null, strict: null },
  reportOnly: true,
  sentence: "You went no-contact with tests, then checked their status every five minutes in CI.",
  measure: "testCount",
  run: (context) => Promise.resolve(countTestsPerPackage(context)),
};
