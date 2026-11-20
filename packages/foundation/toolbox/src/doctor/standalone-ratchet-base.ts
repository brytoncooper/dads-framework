import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compareToBase, type ReadAtRef } from "./doctor-gate-base.js";
import { parseGateBaseline } from "./doctor-gate-baseline.js";
import { BASELINE_PATH, type GateBaseline } from "./doctor-gate-model.js";
import { runGit } from "./signals/scanners/git-history.js";
import {
  parseRatchetPolicy,
  RATCHET_POLICY_PATH,
  serializeRatchetPolicy,
  type RatchetPolicy,
} from "./standalone-ratchet-policy.js";

export function protectAdoptedBase(
  root: string,
  ref: string,
  policy: RatchetPolicy | undefined,
): void {
  const revision = runGit(root, "rev-parse", [
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (revision.status !== 0) throw new Error(`Cannot resolve base ref ${ref}.`);
  const sha = revision.stdout.trim();
  const readAtRef: ReadAtRef = (oid, path) =>
    runGit(root, "show", [`${oid}:${path}`]);
  const previousPolicy = readAtRef(sha, RATCHET_POLICY_PATH);
  if (policy === undefined) {
    if (previousPolicy.status === 0)
      throw new Error(`${RATCHET_POLICY_PATH} was removed relative to ${ref}.`);
    return;
  }
  if (
    previousPolicy.status !== 0 ||
    serializeRatchetPolicy(policy) !==
      serializeRatchetPolicy(parseRatchetPolicy(previousPolicy.stdout))
  ) {
    throw new Error(`${RATCHET_POLICY_PATH} changed relative to ${ref}.`);
  }
  assertBaselineAgainstBase(root, ref, sha, readAtRef);
}

function assertBaselineAgainstBase(
  root: string,
  ref: string,
  sha: string,
  readAtRef: ReadAtRef,
): void {
  const previous = readAtRef(sha, BASELINE_PATH);
  if (previous.status !== 0)
    throw new Error(`${BASELINE_PATH} does not exist at ${ref}.`);
  const baseline = parseGateBaseline(
    readFileSync(join(root, BASELINE_PATH), "utf8"),
  );
  const oldBaseline = parseGateBaseline(previous.stdout);
  if (
    JSON.stringify([...baseline.exempt].sort()) !==
    JSON.stringify([...oldBaseline.exempt].sort())
  ) {
    throw new Error(
      `${BASELINE_PATH}: exempt paths changed relative to ${ref}.`,
    );
  }
  const comparison = compareToBase({ baseline, base: sha, readAtRef });
  const rejected = [
    ...comparison.findings
      .filter((finding) => finding.level === "error")
      .map(
        (finding) => `${finding.measure} ${finding.key}: ${finding.message}`,
      ),
    ...newCeilings(baseline, oldBaseline),
  ];
  if (rejected.length > 0) throw new Error(rejected.join("\n"));
}

function newCeilings(current: GateBaseline, previous: GateBaseline): string[] {
  const additions: string[] = [];
  for (const [section, entries] of current.ceilings) {
    const previousEntries = previous.ceilings.get(section);
    for (const key of entries.keys()) {
      if (!previousEntries?.has(key))
        additions.push(`${section} ${key}: new exception`);
    }
  }
  return additions;
}
