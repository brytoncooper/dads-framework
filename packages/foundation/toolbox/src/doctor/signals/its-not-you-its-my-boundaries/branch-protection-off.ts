/**
 * The default branch, unprotected on the forge: report, and 0 in strict.
 *
 * Every other boundary in this issue is one this repository can hold by itself
 * — a hook, a workflow, a compiler flag. This one it cannot. The branch the
 * whole team merges into is protected on somebody's server or it is not, and a
 * checkout has no way of knowing which. So the question is asked where the
 * answer lives, and the reading is one key: the branch, at 1 when the forge
 * says nothing protects it.
 *
 * Three answers and three different lines. Protection that exists is 0. A 404
 * is the finding, because that is how GitHub says this branch has no protection
 * rule. A 401 or a 403 is not a finding at all: an anonymous request cannot see
 * protection on a private repository, and reading "you may not look" as "there
 * is nothing there" is exactly the reassurance this issue is about. That is a
 * failure naming the status, so the line says it was not measured.
 *
 * A remote that is not on GitHub is the same refusal. Another forge answers
 * this question in another shape, and a repository that has never been pushed
 * anywhere is not an unprotected branch; it is a question nobody can ask yet.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import {
  readJsonObject,
  readStringField,
  repositoryUrl,
  requireOnline,
  requireOriginRepository,
} from "../scanners/online-requests.js";

const OK = 200;
const NOT_FOUND = 404;
const GITHUB = "https://github.com";

async function measureBranchProtection(
  context: DoctorContext,
): Promise<SignalReadings> {
  requireOnline(context);
  const named = requireOriginRepository(context);
  const repository = repositoryUrl(named);
  const branch = await readDefaultBranch(context, repository);
  const url = `${repository}/branches/${encodeURIComponent(branch)}/protection`;
  return new Map([
    [
      branch,
      {
        value: await readProtectionValue(context, url),
        evidence: [
          {
            path: `${GITHUB}/${named.owner}/${named.repository}/settings/branches`,
            name: `default branch ${branch}`,
          },
        ],
      },
    ],
  ]);
}

/**
 * 0 when the forge holds the branch, 1 when it says no rule does. Every other
 * status is a failure that names it, so a repository nobody may read about is
 * never reported as a repository nobody protects.
 */
async function readProtectionValue(
  context: DoctorContext,
  url: string,
): Promise<number> {
  const answered = await context.fetch(url);
  if (answered.status === OK) return 0;
  if (answered.status === NOT_FOUND) return 1;
  throw new Error(`${url} answered ${answered.status}`);
}

async function readDefaultBranch(
  context: DoctorContext,
  repository: string,
): Promise<string> {
  const document = await readJsonObject(context, repository);
  const branch = readStringField(document, "default_branch");
  if (branch === undefined) {
    throw new Error(`${repository} named no default branch`);
  }
  return branch;
}

export const branchProtectionOffSignal: DoctorSignal = {
  id: "branch-protection-off",
  issue: "its-not-you-its-my-boundaries",
  question: "Is the default branch unprotected on the forge that hosts it?",
  reads: "online",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence: "That is a house with no curfew.",
  run: (context) => measureBranchProtection(context),
};
