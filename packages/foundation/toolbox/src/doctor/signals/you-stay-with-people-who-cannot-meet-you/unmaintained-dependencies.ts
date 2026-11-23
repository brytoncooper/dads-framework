/**
 * How long ago a dependency was last published: report, and 0 in strict.
 *
 * A package with a beautiful README and no release in three years is not free.
 * It is a decision somebody else stopped making, and every consumer keeps
 * making it for them: the next CVE, the next Node major, the next type change
 * are all yours now. The number here is the months past twenty-four, so a
 * dependency published two years ago reads as 0 and one published three years
 * ago reads as 12.
 *
 * The key is the package, and the evidence is the manifest that declares it —
 * the file somebody has to open to remove it. A workspace package is not asked
 * about: it is not somebody else's release cadence, it is this repository's.
 *
 * Two refusals rather than two guesses. Without `--online` there is no registry
 * to ask, and without `--today` there is no day to measure against; either way
 * the line says it was not measured, because "no dependency is stale" and "I
 * could not tell" are different claims and only one of them is true.
 */

import { isRecord } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { requireToday } from "../scanners/git-history.js";
import { NPM_REGISTRY, readJsonObject, readStringField, requireOnline } from "../scanners/online-requests.js";
import { readPackageGraph } from "../scanners/package-graph.js";

/** How long a release may be, before Dad calls it a situationship. */
const MONTHS_ALLOWED = 24;

const MONTHS_IN_A_YEAR = 12;
const ISO_DAY = 10;

/** One dependency name, and the manifest a reader opens to drop it. */
type DeclaredDependency = {
  readonly name: string;
  readonly manifest: string;
};

async function measureLastPublish(context: DoctorContext): Promise<SignalReadings> {
  requireOnline(context);
  const today = requireToday(context.today);
  const readings = new Map<string, SignalReading>();
  for (const declared of declaredDependencies(context)) {
    const published = await readLastPublish(context, declared.name);
    const months = monthsBetween(published, today);
    readings.set(declared.name, {
      value: Math.max(0, months - MONTHS_ALLOWED),
      evidence: [
        {
          path: declared.manifest,
          name: `${declared.name} last published ${published.slice(0, ISO_DAY)}`,
        },
      ],
    });
  }
  return readings;
}

/**
 * Every dependency any manifest in the workspace declares, once, named against
 * the first manifest that declares it and sorted so two runs ask in one order.
 */
function declaredDependencies(context: DoctorContext): readonly DeclaredDependency[] {
  const graph = readPackageGraph(context);
  const declaring = new Map<string, string>();
  for (const manifest of graph.manifests) {
    for (const name of manifest.dependencies) {
      if (graph.workspaceNames.has(name)) continue;
      if (!declaring.has(name)) declaring.set(name, manifest.path);
    }
  }
  return [...declaring]
    .map(([name, manifest]) => ({ name, manifest }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The registry's own last-modified date for a package. The full packument
 * carries it under `time`, the abbreviated one at the top level, and a
 * document with neither is a failure rather than a dependency of age zero.
 */
async function readLastPublish(context: DoctorContext, name: string): Promise<string> {
  const url = packumentUrl(name);
  const document = await readJsonObject(context, url);
  const time: unknown = document["time"];
  const modified = isRecord(time) ? readStringField(time, "modified") : readStringField(document, "modified");
  if (modified === undefined) throw new Error(`${url} named no last publish`);
  return modified;
}

/** `@scope/name` is two path segments to the registry, not one escaped one. */
function packumentUrl(name: string): string {
  const path = name.split("/").map(encodeURIComponent).join("/");
  return `${NPM_REGISTRY}/${path}`;
}

/** Whole months from a publish date to the day `--today` named. */
function monthsBetween(published: string, today: string): number {
  const from = new Date(published);
  const to = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error(`${published} is not a date`);
  }
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * MONTHS_IN_A_YEAR + (to.getUTCMonth() - from.getUTCMonth());
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months;
}

export const unmaintainedDependenciesSignal: DoctorSignal = {
  id: "unmaintained-dependencies",
  issue: "you-stay-with-people-who-cannot-meet-you",
  question: "Has any dependency's last publish been more than 24 months ago?",
  reads: "online",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "You attract emotionally unavailable packages. Beautiful README. Last release three years ago. You can fix him.",
  run: (context) => measureLastPublish(context),
};
