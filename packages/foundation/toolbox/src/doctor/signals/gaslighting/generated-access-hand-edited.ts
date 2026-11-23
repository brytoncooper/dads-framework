/**
 * Generated access schemas edited by hand: ceiling 0.
 *
 * The access kit writes a `.zed` schema from a package's TypeScript access
 * declarations and puts its banner on the first line. Edit the schema by hand
 * and the authorization server enforces a rule the declarations do not hold:
 * the code a reviewer reads says one thing, the graph that answers says
 * another, and the next regeneration erases the difference without a word.
 *
 * Each commit that added or changed a bannered schema is read. It is authored
 * when the same commit also changed TypeScript (not a test) in the package the
 * schema belongs to, or changed a `package.json` or the lockfile, because a
 * kit upgrade regenerates every schema at once. Anything else counts once
 * against the schema.
 *
 * Every bannered schema the tree holds is a key, zeros included; their history
 * is read and nobody else's.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { accessArtifacts, declaredRootsOf, owningRoot } from "../scanners/access-artifacts.js";
import { readCommitLog, requireGitWorkspace, shortSha, type GitCommit } from "../scanners/git-history.js";
import { isTestSource } from "../scanners/source-classification.js";
import { addFinding } from "../scanners/typescript-program.js";

const WRITTEN = new Set(["A", "M"]);
const AUTHORING_EXTENSIONS = [".ts", ".tsx"];
const DEPENDENCY_FILES = ["package.json", "package-lock.json"];

function isDependencyFile(path: string): boolean {
  return DEPENDENCY_FILES.some((name) => path === name || path.endsWith(`/${name}`));
}

function isAuthoring(path: string, root: string): boolean {
  if (isDependencyFile(path)) return true;
  if (!AUTHORING_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    return false;
  }
  return !isTestSource(path) && path.startsWith(`${root}/`);
}

/** True when the commit carries the source the schema was generated from. */
function carriesAuthoring(commit: GitCommit, root: string): boolean {
  return commit.changes.some((change) => isAuthoring(change.path, root));
}

function countHandEditedSchemas(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const roots = declaredRootsOf(context);
  const readings = new Map<string, SignalReading>(
    accessArtifacts(context).map((path) => [path, { value: 0, evidence: [] }]),
  );
  for (const commit of readCommitLog(context.root)) {
    for (const change of commit.changes) {
      if (!WRITTEN.has(change.status) || !readings.has(change.path)) continue;
      if (carriesAuthoring(commit, owningRoot(change.path, roots))) continue;
      addFinding(readings, change.path, {
        path: change.path,
        name: `${shortSha(commit.sha)} ${commit.message}`,
      });
    }
  }
  return readings;
}

export const generatedAccessHandEditedSignal: DoctorSignal = {
  id: "generated-access-hand-edited",
  issue: "gaslighting",
  question:
    "Was a generated access schema changed in a commit that changed none of the declarations it is generated from?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "If you need the euphemism to live with it, you already know.",
  run: (context) => Promise.resolve(countHandEditedSchemas(context)),
};
