/**
 * Suppressions that have stood still for ninety days: report, 0 in strict.
 *
 * The healthy version of an exception is written down, dated, given a reason,
 * and only ever allowed to shrink. A bulk suppressions file is the written-down
 * part and nothing else: it carries a count per file per rule and no date at
 * all. The date is in the history of the file, and so is the only question
 * worth asking of it — when did this count last come down?
 *
 * So each entry is aged from the newest commit where its count fell, or from
 * the commit that first recorded it when it has never fallen. An entry past
 * ninety days with no downward move counts one; everything else counts zero, so
 * a file full of suppressions that are all actively shrinking reads clean and a
 * single fossil reads as one.
 *
 * Ninety days is the companion's number and not the profile's, which is why it
 * is written here and not in the thresholds: the profile decides how many
 * fossils are allowed, not how old a fossil is.
 */

import { isRecord } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import {
  daysBefore,
  readFileAtRevision,
  readPathRevisions,
  requireGitWorkspace,
  requireToday,
  type GitRevision,
} from "../scanners/git-history.js";

const SUPPRESSIONS_PATH = "eslint-suppressions.json";
const STALE_DAYS = 90;
const COUNT = "count";

type SuppressionCounts = ReadonlyMap<string, number>;

/** Every `<file> <rule>` entry one revision of the suppressions file records. */
function readSuppressionCounts(text: string): SuppressionCounts {
  const counts = new Map<string, number>();
  const parsed = parseSuppressions(text);
  if (parsed === undefined) return counts;
  for (const [file, rules] of Object.entries(parsed)) {
    if (!isRecord(rules)) continue;
    for (const [rule, entry] of Object.entries(rules)) {
      const count = isRecord(entry) ? entry[COUNT] : undefined;
      if (typeof count === "number") counts.set(`${file} ${rule}`, count);
    }
  }
  return counts;
}

function parseSuppressions(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type SuppressionRevision = {
  readonly revision: GitRevision;
  readonly counts: SuppressionCounts;
};

function readSuppressionHistory(root: string): readonly SuppressionRevision[] {
  return readPathRevisions(root, SUPPRESSIONS_PATH).flatMap((revision) => {
    const text = readFileAtRevision(root, revision.sha, SUPPRESSIONS_PATH);
    if (text === undefined) return [];
    return [{ revision, counts: readSuppressionCounts(text) }];
  });
}

/** The newest commit where the count fell, or the one that first recorded it. */
function lastDownwardMove(history: readonly SuppressionRevision[], key: string): string | undefined {
  let recorded: string | undefined;
  for (let index = 0; index < history.length; index += 1) {
    const current = history[index]?.counts.get(key);
    if (current === undefined) break;
    recorded = history[index]?.revision.date;
    const older = history[index + 1]?.counts.get(key);
    if (older === undefined) break;
    if (current < older) return history[index]?.revision.date;
  }
  return recorded;
}

function ageSuppressions(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const today = requireToday(context.today);
  const history = readSuppressionHistory(context.root);
  const newest = history[0];
  if (newest === undefined) return new Map();
  const readings = new Map<string, SignalReading>();
  for (const key of newest.counts.keys()) {
    const moved = lastDownwardMove(history, key);
    if (moved === undefined) continue;
    const age = daysBefore(moved, today);
    readings.set(key, {
      value: age > STALE_DAYS ? 1 : 0,
      evidence: [{ path: SUPPRESSIONS_PATH, name: `${key}, ${age} days` }],
    });
  }
  return readings;
}

export const suppressionAgeSignal: DoctorSignal = {
  id: "suppression-age",
  issue: "the-silent-treatment",
  question: "Is any suppression older than 90 days with no downward move?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence: "A suppressions file nobody has opened since the day it was generated.",
  run: (context) => Promise.resolve(ageSuppressions(context)),
};
