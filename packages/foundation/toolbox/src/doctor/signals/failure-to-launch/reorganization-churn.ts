/**
 * Reparenting `src/` again: report, 20% in strict.
 *
 * Moving files is how a codebase looks busy while nothing gets a contract. The
 * tell is a commit that only moves things: nothing was added, nothing was
 * fixed, every path in the diff is the same content under a new name. One of
 * those is a tidy-up. A fifth of the last quarter is a habit.
 *
 * The window is the ninety days before `--today`, so the number describes the
 * present rather than the whole history of a repository that has since settled
 * down. Merge commits are not in it: a merge moves nothing on its own, and
 * counting one would credit the branch's work twice.
 *
 * Rename detection is git's, at its default similarity, which is the same
 * detection a reviewer sees in the diff. A commit that moves a file and also
 * edits one line of it is not rename-only, and that is the intended reading:
 * the failure is motion with no change in it.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import {
  readCommitLog,
  requireGitWorkspace,
  requireToday,
  shiftDays,
  shortSha,
  type GitCommit,
} from "../scanners/git-history.js";

const WINDOW_DAYS = 90;
const READING_KEY = "last 90 days";
const WHOLE = 100;
const MOVED = ["R", "C"];

/** True when every path the commit touched arrived there by being moved. */
function isMoveOnly(commit: GitCommit): boolean {
  return commit.changes.every((change) =>
    MOVED.some((status) => change.status.startsWith(status)),
  );
}

function measureReorganizationChurn(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const today = requireToday(context.today);
  const commits = readCommitLog(context.root, {
    since: shiftDays(today, -WINDOW_DAYS),
    detectRenames: true,
  }).filter((commit) => commit.changes.length > 0);
  if (commits.length === 0) return new Map();
  const moved = commits.filter((commit) => isMoveOnly(commit));
  return new Map([
    [
      READING_KEY,
      {
        value: Math.round((moved.length * WHOLE) / commits.length),
        evidence: moved.map((commit) => ({
          path: commit.changes[0]?.path ?? "",
          name: `${shortSha(commit.sha)} ${commit.message}`,
        })),
      },
    ],
  ]);
}

export const reorganizationChurnSignal: DoctorSignal = {
  id: "reorganization-churn",
  issue: "failure-to-launch",
  question:
    "Is the share of rename-only commits in the last 90 days above the profile's threshold?",
  reads: "git",
  unit: "percent",
  direction: "ceiling",
  thresholds: { standard: null, strict: 20 },
  sentence:
    "2:14 a.m. Reparenting `src/`. Again. You said last time was last time.",
  run: (context) => Promise.resolve(measureReorganizationChurn(context)),
};
