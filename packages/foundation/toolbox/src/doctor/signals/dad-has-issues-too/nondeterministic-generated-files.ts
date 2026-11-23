/**
 * Generated files that churn on their own: report, 0 in strict.
 *
 * A generator whose output changes when its input did not is a rule producing
 * noise. The diff is real, the review is empty, and after the third one nobody
 * reads that file in a pull request again — which is how a generated file stops
 * being checked at all. The evidence is a commit that changed nothing but
 * generated files: if the inputs had moved, the same commit would carry them.
 *
 * Generated means what it means everywhere else in this command: a
 * `.generated.ts` module, an extracted API report, and anything under a build
 * directory. Lock files are deliberately not on the list. A lock file that
 * moves without its manifest is a dependency update somebody meant, not a
 * generator disagreeing with itself.
 *
 * The window is the ninety days before `--today`, so the reading describes the
 * generator that is running now rather than one that was replaced a year ago.
 * The key is the file, because the file is the thing that gets fixed.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReadings } from "../../doctor-signal.js";
import {
  readCommitLog,
  requireGitWorkspace,
  requireToday,
  shiftDays,
  shortSha,
  type GitCommit,
} from "../scanners/git-history.js";

const WINDOW_DAYS = 90;
const GENERATED_SUFFIXES = [".generated.ts", ".api.md"];
const BUILD_DIRECTORIES = new Set(["dist", "target", "node_modules"]);

/** True for a path nobody typed: emitted source, an API report, build output. */
function isGeneratedPath(path: string): boolean {
  if (GENERATED_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true;
  return path.split("/").some((segment) => BUILD_DIRECTORIES.has(segment));
}

/** True when the commit touched something and all of it was generated. */
function isGeneratedOnly(commit: GitCommit): boolean {
  return commit.changes.length > 0 && commit.changes.every((change) => isGeneratedPath(change.path));
}

function countGeneratedChurn(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const today = requireToday(context.today);
  const commits = readCommitLog(context.root, {
    since: shiftDays(today, -WINDOW_DAYS),
    detectRenames: true,
  }).filter((commit) => isGeneratedOnly(commit));
  const churn = new Map<string, SignalEvidence[]>();
  for (const commit of commits) {
    for (const change of commit.changes) {
      const found = churn.get(change.path) ?? [];
      found.push({
        path: change.path,
        name: `${shortSha(commit.sha)} ${commit.message}`,
      });
      churn.set(change.path, found);
    }
  }
  return new Map([...churn].map(([path, evidence]) => [path, { value: evidence.length, evidence }]));
}

export const nondeterministicGeneratedFilesSignal: DoctorSignal = {
  id: "nondeterministic-generated-files",
  issue: "dad-has-issues-too",
  question: "Does any generated file churn without its input changing?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence: "A warning at `warn` that everybody learned to scroll past.",
  run: (context) => Promise.resolve(countGeneratedChurn(context)),
};
