/**
 * How old the breadcrumbs are: report, 30 days in strict.
 *
 * A marker left in a comment is a promise with no date on it, and the essay's
 * example is the one that matters — a permission left as a note on a route that
 * has been in production since March. The note is not the problem. The note
 * being nine months old is.
 *
 * So the reading is an age, not a count, and the age comes from blame: the day
 * the line carrying the marker was last written. A file is reported once, at
 * the age of its oldest marker, because the file is the thing somebody opens.
 * A line nobody has committed yet has no age and is left out; dating an
 * uncommitted line to today would let a marker restart its clock by being moved
 * two lines down.
 *
 * Only markers in comments count. The word appears in a string literal in
 * generated scaffolding and in prose in a document, and neither is a promise
 * anybody made. The two names are assembled from their parts for the same
 * reason the escape hatches are: this file would otherwise be read by its own
 * signal as a nine-month-old promise.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  blameLineDates,
  daysBefore,
  requireGitWorkspace,
  requireToday,
} from "../scanners/git-history.js";
import { budgetedSourceFiles } from "../scanners/source-classification.js";

/** The two markers, joined at load time so this module does not carry one. */
const MARKS = [["TO", "DO"].join(""), ["FIX", "ME"].join("")];

/** A marker that opens a comment, or continues a block comment's margin. */
const MARKER = new RegExp(
  `(?://|/\\*+|^\\s*[*#])\\s*(?:${MARKS.join("|")})\\b`,
);

/** The one-based lines of a file whose comment carries a marker. */
function markedLines(text: string): readonly number[] {
  return text
    .split("\n")
    .flatMap((line, index) => (MARKER.test(line) ? [index + 1] : []));
}

function ageOneFile(
  context: DoctorContext,
  path: string,
  today: string,
  lines: readonly number[],
): SignalReading {
  const dates = blameLineDates(context.root, path);
  const evidence: SignalEvidence[] = [];
  let oldest = 0;
  for (const line of lines) {
    const written = dates.get(line);
    if (written === undefined) continue;
    const age = daysBefore(written, today);
    oldest = Math.max(oldest, age);
    evidence.push({ path, line, name: `${age} days` });
  }
  return { value: oldest, evidence };
}

function ageMarkedPromises(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const today = requireToday(context.today);
  const readings = new Map<string, SignalReading>();
  for (const path of budgetedSourceFiles(context.files())) {
    const lines = markedLines(context.read(path));
    if (lines.length === 0) continue;
    const reading = ageOneFile(context, path, today, lines);
    if (reading.evidence.length > 0) readings.set(path, reading);
  }
  return readings;
}

export const todoAgeSignal: DoctorSignal = {
  id: "todo-age",
  issue: "commitment-issues",
  question:
    "Is there a TODO or FIXME mentioning permission or auth within twenty lines of a route, or older than the profile's threshold?",
  reads: "git",
  unit: "days",
  direction: "ceiling",
  thresholds: { standard: null, strict: 30 },
  sentence:
    "You left a breadcrumb instead: `TODO: check permission` on a route that’s been in prod since March.",
  run: (context) => Promise.resolve(ageMarkedPromises(context)),
};
