/**
 * How long a recorded exception has sat still: 180 days, 90 in strict.
 *
 * An entry in the baseline is a debt Dad agreed to carry for a while. The
 * agreement is that it moves. A mark that has not moved since the day it was
 * seeded is not scaffolding any more, it is architecture nobody voted for, and
 * the number that says so is the number of days between the commit that last
 * changed it and the day the report is about.
 *
 * Ceilings only. A floor is a count that has to keep rising and a floor that
 * sits still is a package nobody added a test to, which is the floor's own
 * business and a different signal's question. Debt is the exception somebody
 * recorded so that a violation could stay, and that is what a ceiling entry is.
 *
 * The age is measured against `--today`, never a clock, so two runs over the
 * same tree on the same declared day print the same number. A workspace with no
 * recorded ceilings has no debt to age and says it was not measured, because
 * zero days would read as debt that moved this morning.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  daysBefore,
  requireGitWorkspace,
  requireToday,
} from "../scanners/git-history.js";
import {
  BASELINE_PATH,
  NO_RATCHET_BASELINE,
  lastMoveDate,
  readBaselineHistory,
} from "../scanners/ratchet-baseline-history.js";

const CEILINGS = "ceilings/";

function ageRecordedDebt(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const today = requireToday(context.today);
  const history = readBaselineHistory(context.root);
  const newest = history[0];
  if (newest === undefined) throw new Error(NO_RATCHET_BASELINE);
  const readings = new Map<string, SignalReading>();
  for (const key of newest.entries.keys()) {
    if (!key.startsWith(CEILINGS)) continue;
    const moved = lastMoveDate(history, key);
    if (moved === undefined) continue;
    readings.set(key, {
      value: daysBefore(moved, today),
      evidence: [{ path: BASELINE_PATH, name: `${key} last moved ${moved}` }],
    });
  }
  return readings;
}

export const stagnantDebtSignal: DoctorSignal = {
  id: "stagnant-debt",
  issue: "dad-has-issues-too",
  question:
    "Is any baseline entry older than the profile's threshold whose mark never moved?",
  reads: "git",
  unit: "days",
  direction: "ceiling",
  thresholds: { standard: 180, strict: 90 },
  sentence:
    "The ratchet has a decommission date, because scaffolding that becomes architecture is just a wall you forgot you built.",
  run: (context) => Promise.resolve(ageRecordedDebt(context)),
};
