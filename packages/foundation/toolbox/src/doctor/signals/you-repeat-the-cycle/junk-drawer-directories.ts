/**
 * Directories named for having no owner: ceiling 0.
 *
 * `helpers/`, `utils/`, `common/`, `misc/`, `shared/`. The essay is blunt
 * about what they are — "not a folder", "a daddy wound with an index file" —
 * and the reason is that the name is the admission. Every other directory in
 * a repository says what lives in it; these five say only that somebody had a
 * file and nowhere to put it. Once one exists, the next file with no owner
 * goes there too, and nothing in the name will ever say it should not.
 *
 * The reading is the literal one the companion asks for: a directory with one
 * of those names, anywhere under the source roots. It counts the files inside
 * so the number says how much has already collected there, and its evidence
 * names them, because "rename the folder" is not the fix and the list of what
 * is in it is where the real one starts.
 *
 * A package named `shared`, `common`, or `utils` is a different failure with a
 * different reading: `shared-catchall` counts its importers.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { SOURCE_ROOTS } from "../scanners/source-classification.js";

const DRAWER_NAMES = new Set(["helpers", "utils", "common", "misc", "shared"]);
const SHOWN_FILES = 5;

/** Every drawer directory a path sits inside, outermost first. */
function drawersAlong(path: string): readonly string[] {
  const segments = path.split("/");
  const found: string[] = [];
  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const name = segments[depth];
    if (name !== undefined && DRAWER_NAMES.has(name)) {
      found.push(segments.slice(0, depth + 1).join("/"));
    }
  }
  return found;
}

function collectDrawers(context: DoctorContext): ReadonlyMap<string, readonly string[]> {
  const drawers = new Map<string, string[]>();
  for (const path of context.files()) {
    if (!SOURCE_ROOTS.some((root) => path.startsWith(root))) continue;
    for (const drawer of drawersAlong(path)) {
      const held = drawers.get(drawer) ?? [];
      held.push(path);
      drawers.set(drawer, held);
    }
  }
  return drawers;
}

function countJunkDrawers(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const [drawer, held] of collectDrawers(context)) {
    const evidence: SignalEvidence[] = held.slice(0, SHOWN_FILES).map((path) => ({ path }));
    readings.set(drawer, {
      value: held.length,
      evidence: [{ path: drawer, name: drawer }, ...evidence],
    });
  }
  return readings;
}

export const junkDrawerDirectoriesSignal: DoctorSignal = {
  id: "junk-drawer-directories",
  issue: "you-repeat-the-cycle",
  question: "Is there a directory named `helpers/`, `utils/`, `common/`, `misc/`, or `shared/`?",
  reads: "text",
  unit: "files",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "Eventually everything nobody wanted to raise ends up in `helpers/`. That is not a folder. That is a daddy wound with an index file.",
  run: (context) => Promise.resolve(countJunkDrawers(context)),
};
