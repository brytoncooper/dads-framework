/** Local records of complete verification over a commit and its history inputs. */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { relevantEnvironment } from "./verify-cache.mjs";
import { captureFingerprint, captureHistory, git, sameFingerprint, sameHistory } from "./verify-fingerprint.mjs";
import { verifySteps } from "./verify-graph.mjs";

const VERSION = 2;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function committedTree(root, revision) {
  const tree = git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}^{tree}`]).trim();
  if (!OBJECT_ID.test(tree)) throw new Error("Git returned an invalid tree ID.");
  return tree;
}

export function committedProofContext(root, revision) {
  const history = captureHistory(root, revision);
  const tree = committedTree(root, history.commit ?? revision);
  return { tree, history };
}

export function proofKey(committed, ignored) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: VERSION,
        committed,
        ignored,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        environment: relevantEnvironment(process.env),
        ci: process.env.CI,
      }),
    )
    .digest("hex");
}

function receiptPath(root, tree, key, full) {
  const gitDirectory = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return resolve(gitDirectory, "dads", "verify-receipts", tree, key, full ? "full.json" : "verify.json");
}

/** The real index and the working files must both be the committed tree. */
export function captureProof(root, knownFingerprint) {
  try {
    const committed = committedProofContext(root, "HEAD");
    const indexEntries = git(root, ["ls-files", "-v", "-z"]).split("\0");
    if (indexEntries.some((entry) => entry !== "" && !entry.startsWith("H "))) return null;
    if (git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]) !== "")
      return null;
    const fingerprint = knownFingerprint ?? captureFingerprint(root);
    if (
      fingerprint.tree !== committed.tree ||
      !sameHistory(fingerprint.history, committed.history) ||
      Object.values(fingerprint.entries).some((entry) => entry.startsWith("commit:"))
    )
      return null;
    if (fingerprint.ignored.some(([, hash]) => hash.startsWith("link:"))) return null;
    return {
      fingerprint,
      committed,
      key: proofKey(committed, fingerprint.ignored),
    };
  } catch {
    return null;
  }
}

function graphIds(full) {
  return verifySteps({ full }).map((step) => step.id);
}

export function recordProof(root, before, run, { full, uncached }, knownFingerprint) {
  if (before === null || run.exitCode !== 0 || (full && !uncached)) return false;
  const after = captureProof(root, knownFingerprint);
  if (after === null || after.key !== before.key || !sameFingerprint(before.fingerprint, after.fingerprint))
    return false;
  if (run.results.some((result) => result.status !== "passed")) return false;
  if (uncached && run.results.some((result) => result.cache != null)) return false;
  const steps = run.results.map((result) => result.step.id);
  if (JSON.stringify(steps) !== JSON.stringify(graphIds(full))) return false;
  const { tree, history } = after.committed;
  const path = receiptPath(root, tree, after.key, full);
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.${randomUUID()}.partial`;
  try {
    const receipt = {
      version: VERSION,
      tree,
      history,
      key: after.key,
      full,
      uncached,
      passedAt: new Date().toISOString(),
      steps,
    };
    writeFileSync(pending, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
  return true;
}

function readProof(root, { tree, history }, key, full) {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(root, tree, key, full), "utf8"));
    return (
      receipt.version === VERSION &&
      receipt.tree === tree &&
      sameHistory(receipt.history, history) &&
      receipt.key === key &&
      receipt.full === full &&
      typeof receipt.uncached === "boolean" &&
      (!full || receipt.uncached) &&
      typeof receipt.passedAt === "string" &&
      Number.isFinite(Date.parse(receipt.passedAt)) &&
      JSON.stringify(receipt.steps) === JSON.stringify(graphIds(full))
    );
  } catch {
    return false;
  }
}

export function hasProof(root, committed, key, full = false) {
  return readProof(root, committed, key, true) || (!full && readProof(root, committed, key, false));
}
