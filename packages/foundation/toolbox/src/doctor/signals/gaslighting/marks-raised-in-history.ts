/**
 * Marks that moved the wrong way: ceiling 0.
 *
 * A ratchet is only a ratchet if the record of it says so. The baseline today
 * cannot tell anybody whether a ceiling was raised the week somebody hit it,
 * because the raised number looks exactly like a number that was always there.
 * The history can, and it is the only thing that can, which is why this reading
 * is a walk through the committed revisions of `.agents/source-budgets.json`
 * rather than a look at the file on disk.
 *
 * One rule, both directions: a ceiling that went up and a floor that came down
 * are the same move, and each is counted once per commit that made it. The one
 * fall that is not a move is the one the same commit accounts for: a floor
 * whose entry names the key its count went to, where that key rose by at least
 * as much in the same diff. A split says so in the diff that makes it, and a
 * split that says so is not a mark that moved. Only entries present on both
 * sides of a diff are compared. A key that stopped
 * existing is a measure that stopped being taken — a rename, a package that
 * left — and the ratchet's own `--base` mode owns that question; calling it a
 * raised mark here would report every reorganization as a loosening.
 *
 * The reading is per entry rather than per commit, because "which mark moved"
 * is the thing a reader needs and "how many commits were involved" is not.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReadings } from "../../doctor-signal.js";
import { doctorCasesSignal } from "../dad-has-issues-too/doctor-cases.js";
import { testCountSignal } from "../commitment-issues/test-count.js";
import { shortSha, requireGitWorkspace } from "../scanners/git-history.js";
import {
  BASELINE_PATH,
  NO_RATCHET_BASELINE,
  isLoosening,
  readBaselineHistory,
  transferCoversFall,
  type BaselineRevision,
} from "../scanners/ratchet-baseline-history.js";

/** Every loosening move one pair of neighbouring revisions recorded. */
/**
 * Baseline paths of the floors the gate only reports. A fall in a count the
 * gate does not hold is not a loosening: dropping those floors from the gate
 * is what let a healthy deletion lower them.
 */
const REPORT_ONLY_PATHS = [testCountSignal, doctorCasesSignal]
  .filter((signal) => signal.reportOnly === true)
  .map((signal) => `floors/${signal.measure ?? signal.id}/`);

function isReportOnly(key: string): boolean {
  return REPORT_ONLY_PATHS.some((prefix) => key.startsWith(prefix));
}

function loosenedBetween(later: BaselineRevision, earlier: BaselineRevision): ReadonlyMap<string, SignalEvidence> {
  const moves = new Map<string, SignalEvidence>();
  for (const [key, entry] of later.entries) {
    if (isReportOnly(key)) continue;
    const before = earlier.entries.get(key);
    if (before === undefined) continue;
    if (!isLoosening(before.value, entry.value, entry.section)) continue;
    const fall = before.value - entry.value;
    if (transferCoversFall(entry, fall, later.entries, earlier.entries)) {
      continue;
    }
    moves.set(key, {
      path: BASELINE_PATH,
      name: `${shortSha(later.revision.sha)} ${key} ${before.value} -> ${entry.value}`,
    });
  }
  return moves;
}

/** Every key a diff in this history could have moved, and how often it did. */
function countLoosenedMarks(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const history = readBaselineHistory(context.root);
  if (history.length === 0) throw new Error(NO_RATCHET_BASELINE);
  const evidence = new Map<string, SignalEvidence[]>();
  for (let index = 0; index + 1 < history.length; index += 1) {
    collectComparedKeys(evidence, history[index], history[index + 1]);
  }
  return new Map([...evidence].map(([key, found]) => [key, { value: found.length, evidence: found }]));
}

function collectComparedKeys(
  evidence: Map<string, SignalEvidence[]>,
  later: BaselineRevision | undefined,
  earlier: BaselineRevision | undefined,
): void {
  if (later === undefined || earlier === undefined) return;
  for (const key of later.entries.keys()) {
    if (isReportOnly(key) || !earlier.entries.has(key)) continue;
    evidence.set(key, evidence.get(key) ?? []);
  }
  for (const [key, moved] of loosenedBetween(later, earlier)) {
    evidence.set(key, [...(evidence.get(key) ?? []), moved]);
  }
}

export const marksRaisedInHistorySignal: DoctorSignal = {
  id: "marks-raised-in-history",
  issue: "gaslighting",
  alsoUnder: ["dad-has-issues-too"],
  question: "Does the baseline's history contain a diff where a ceiling mark went up or a floor came down?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "First you rename the violation. Then you explain why it had to happen.",
  run: (context) => Promise.resolve(countLoosenedMarks(context)),
};
