/** Verify the objects Git is sending, including refs outside the current checkout. */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { recordHookTiming } from "./hooks/record-hook-timing.mjs";
import { git, gitEnvironment, sameHistory } from "./verify-fingerprint.mjs";
import {
  captureProof,
  committedProofContext,
  hasProof,
  proofKey,
} from "./verify-receipt.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function pushedObjects(input, oidLength) {
  const oid = new RegExp(`^[0-9a-f]{${oidLength}}$`, "u");
  const deletion = "0".repeat(oidLength);
  const lines = input === "" ? [] : input.replace(/\n$/u, "").split("\n");
  const objects = new Set();
  for (const line of lines) {
    const fields = line.split(" ");
    const [localRef, local, remoteRef, remote] = fields;
    if (
      fields.length !== 4 ||
      !localRef ||
      !remoteRef ||
      !oid.test(local) ||
      !oid.test(remote) ||
      (local === deletion) !== (localRef === "(delete)")
    ) {
      throw new Error("Git supplied an invalid pre-push ref record.");
    }
    if (local !== deletion) objects.add(local);
  }
  return objects;
}

function run(root, command, args, options = {}) {
  const outcome = spawnSync(command, args, {
    cwd: root,
    env: gitEnvironment({ GIT_NO_REPLACE_OBJECTS: "1" }),
    stdio: "inherit",
    ...options,
  });
  if (outcome.error !== undefined) throw outcome.error;
  if (outcome.status !== 0) {
    throw new Error(`${command} failed (${outcome.status ?? outcome.signal}).`);
  }
}

function verify(root) {
  run(root, process.execPath, ["scripts/verify.mjs", "--require-receipt"]);
}

function verifyDetached(root, object) {
  const scratch = mkdtempSync(join(tmpdir(), "dads-push-"));
  const checkout = join(scratch, "checkout");
  try {
    git(root, ["worktree", "add", "--detach", checkout, object]);
    run(checkout, "npm", ["ci", "--no-audit", "--no-fund"]);
    verify(checkout);
  } finally {
    try {
      if (existsSync(join(checkout, ".git")))
        git(root, ["worktree", "remove", "--force", checkout]);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  }
}

export function verifyPush(root, input) {
  const objectFormat = git(root, ["rev-parse", "--show-object-format"]).trim();
  const oidLength = { sha1: 40, sha256: 64 }[objectFormat];
  if (!Number.isInteger(oidLength))
    throw new Error("Unsupported Git object format.");
  const objects = pushedObjects(input, oidLength);
  let current;
  let cached = objects.size > 0;
  for (const object of objects) {
    // Use the peeled commit for annotated tags and for detached verification.
    const committed = committedProofContext(root, object);
    const cleanKey = proofKey(committed, []);
    if (hasProof(root, committed, cleanKey)) continue;
    current ??= captureProof(root) ?? false;
    const inPlace =
      current !== false &&
      sameHistory(current.committed.history, committed.history);
    if (inPlace && hasProof(root, committed, current.key)) continue;
    cached = false;
    if (inPlace) verify(root);
    else verifyDetached(root, committed.history.commit);
    const verified = committedProofContext(root, object);
    if (
      proofKey(verified, []) !== cleanKey ||
      !hasProof(root, committed, inPlace ? current.key : cleanKey)
    ) {
      throw new Error(
        `No passing verification receipt for pushed object ${object}.`,
      );
    }
  }
  return cached;
}

function localHook(root, input, args) {
  const hook = resolve(
    root,
    git(root, ["rev-parse", "--git-path", "hooks/pre-push.local"]).trim(),
  );
  try {
    accessSync(hook, constants.X_OK);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return;
    throw error;
  }
  run(root, hook, args, {
    env: process.env,
    input,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const startedAt = performance.now();
    const input = readFileSync(0, "utf8");
    const cached = verifyPush(ROOT, input);
    localHook(ROOT, input, process.argv.slice(2));
    if (cached) recordHookTiming("pre-push", startedAt);
  } catch (error) {
    process.stderr.write(`pre-push: ${error.message}\n`);
    process.exitCode = 1;
  }
}
