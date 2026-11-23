import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import test from "node:test";
import { git } from "./verify-fingerprint.mjs";
import { verifySteps } from "./verify-graph.mjs";
import { pushedObjects, verifyPush } from "./verify-pre-push.mjs";
import { captureProof, hasProof, proofKey, recordProof } from "./verify-receipt.mjs";

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "dads-receipt-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.org"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(root, "source.txt"), "original\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "Original tree"]);
  return root;
}

function passingRun(full) {
  return {
    exitCode: 0,
    results: verifySteps({ full }).map((step) => ({ step, status: "passed" })),
  };
}

test("release requires the complete uncached graph for the same inputs", (context) => {
  const root = fixture(context);
  const original = captureProof(root);
  assert.ok(original);
  const committed = original.committed;
  const key = original.key;
  const cached = { full: false, uncached: false };
  assert.equal(recordProof(root, original, passingRun(false), cached), true);
  assert.equal(hasProof(root, committed, key), true);
  assert.equal(hasProof(root, committed, key, true), false);

  const full = { full: true, uncached: true };
  assert.equal(recordProof(root, original, passingRun(false), full), false);
  assert.equal(recordProof(root, original, passingRun(true), { ...full, uncached: false }), false);
  const reused = passingRun(true);
  reused.results[0].cache = "hit";
  assert.equal(recordProof(root, original, reused, full), false);
  assert.equal(recordProof(root, original, passingRun(true), full), true);
  assert.equal(hasProof(root, committed, key, true), true);

  writeFileSync(join(root, "ignored.txt"), "different proof input\n");
  const changed = captureProof(root);
  assert.ok(changed);
  assert.equal(hasProof(root, changed.committed, changed.key, true), false);
  assert.equal(recordProof(root, original, passingRun(true), full), false);
});

test("a release receipt binds verification and toolchain settings", (context) => {
  const root = fixture(context);
  const original = captureProof(root);
  assert.ok(original);
  const committed = original.committed;
  assert.equal(
    recordProof(root, original, passingRun(true), {
      full: true,
      uncached: true,
    }),
    true,
  );
  for (const name of ["NODE_OPTIONS", "VITEST_POOL", "CI", "RUSTUP_TOOLCHAIN"]) {
    const value = process.env[name];
    try {
      process.env[name] = value === "" ? "changed" : "";
      assert.equal(hasProof(root, committed, proofKey(committed, []), true), false, name);
    } finally {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(hasProof(root, committed, original.key, true), true);
});

test("untracked, staged, and assume-unchanged inputs cannot earn a receipt", (context) => {
  const root = fixture(context);
  const original = captureProof(root);
  assert.ok(original);
  const untracked = join(root, "extra.txt");
  writeFileSync(untracked, "untracked\n");
  assert.equal(captureProof(root), null);
  rmSync(untracked);

  writeFileSync(join(root, "source.txt"), "staged only\n");
  git(root, ["add", "source.txt"]);
  writeFileSync(join(root, "source.txt"), "original\n");
  assert.equal(captureProof(root), null);

  git(root, ["reset", "--hard", "HEAD"]);
  git(root, ["update-index", "--assume-unchanged", "source.txt"]);
  assert.equal(captureProof(root), null);
});

test("push uses pushed objects even when HEAD moved and the checkout is dirty", (context) => {
  const root = fixture(context);
  const originalObject = git(root, ["rev-parse", "HEAD"]).trim();
  const original = captureProof(root);
  assert.ok(original);
  assert.equal(
    recordProof(root, original, passingRun(false), {
      full: false,
      uncached: false,
    }),
    true,
  );
  writeFileSync(join(root, "source.txt"), "new commit\n");
  git(root, ["commit", "--quiet", "-am", "New tree"]);
  const current = captureProof(root);
  assert.ok(current);
  writeFileSync(join(root, "extra.txt"), "dirty\n");
  const record = (object) => `refs/heads/source ${object} refs/heads/target ${"0".repeat(object.length)}\n`;

  assert.equal(verifyPush(root, record(originalObject)), true);
  git(root, ["tag", "-a", "verified", originalObject, "-m", "verified"]);
  const annotatedTag = git(root, ["rev-parse", "refs/tags/verified"]).trim();
  assert.equal(verifyPush(root, record(annotatedTag)), true);
  assert.equal(hasProof(root, current.committed, current.key), false);

  const blob = git(root, ["rev-parse", "HEAD:source.txt"]).trim();
  assert.throws(() => verifyPush(root, record(originalObject) + record(blob)), /git rev-parse/u);
});

test("push rejects malformed records and accepts valid deletions", () => {
  const zero = "0".repeat(40);
  const object = "1".repeat(40);
  assert.deepEqual([...pushedObjects(`(delete) ${zero} refs/heads/target ${object}\n`, 40)], []);
  assert.throws(() => pushedObjects(`refs/heads/source ${zero} refs/heads/target ${object}\n`, 40), /invalid/u);
  assert.throws(() => pushedObjects("truncated\n", 40), /invalid/u);
});

test("unproved non-HEAD refs are verified in a detached checkout of that object", (context) => {
  const root = fixture(context);
  const packageName = "receipt-test";
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: packageName }));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: packageName,
      lockfileVersion: 3,
      packages: { "": { name: packageName } },
    }),
  );
  const receipt = new URL("verify-receipt.mjs", import.meta.url).href;
  const graph = new URL("verify-graph.mjs", import.meta.url).href;
  writeFileSync(
    join(scripts, "verify.mjs"),
    `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import { captureProof, recordProof } from ${JSON.stringify(receipt)};
import { verifySteps } from ${JSON.stringify(graph)};
assert.equal(readFileSync("source.txt", "utf8"), "original\\n");
const root = process.cwd();
const before = captureProof(root);
assert.ok(before);
const results = verifySteps({ full: false }).map((step) => ({ step, status: "passed" }));
assert.ok(recordProof(root, before, { exitCode: 0, results }, { full: false, uncached: false }));
`,
  );
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "Add a fixture verifier"]);
  const pushedObject = git(root, ["rev-parse", "HEAD"]).trim();
  const pushed = captureProof(root);
  assert.ok(pushed);
  writeFileSync(join(root, "source.txt"), "different HEAD\n");
  git(root, ["commit", "--quiet", "-am", "Change source"]);

  const zero = "0".repeat(pushedObject.length);
  const input = `refs/heads/other ${pushedObject} refs/heads/target ${zero}\n`;
  assert.equal(hasProof(root, pushed.committed, pushed.key), false);
  git(root, ["config", "core.hooksPath", join(root, ".git/hooks")]);
  const checkoutLog = join(root, ".git", "checkout-hook.log");
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  writeFileSync(
    join(root, ".git/hooks/post-checkout"),
    "#!/bin/sh\nprintf 'checkout\\n' >> " + JSON.stringify(checkoutLog) + "\n",
    { mode: 0o700 },
  );
  assert.doesNotThrow(() => verifyPush(root, input));
  assert.equal(hasProof(root, pushed.committed, pushed.key), true);
  assert.equal(readFileSync(checkoutLog, "utf8"), "checkout\n");
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "different HEAD\n");
});

test("an identical tree cannot reuse proof after HEAD history or comparison base changes", (context) => {
  const root = fixture(context);
  const first = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["update-ref", "refs/remotes/origin/main", first]);
  const original = captureProof(root);
  assert.ok(original);
  const options = { full: false, uncached: false };
  assert.equal(recordProof(root, original, passingRun(false), options), true);

  git(root, ["commit", "--allow-empty", "--quiet", "-m", "A different history"]);
  const moved = captureProof(root);
  assert.ok(moved);
  assert.equal(moved.fingerprint.tree, original.fingerprint.tree);
  assert.notEqual(moved.key, original.key);
  assert.equal(recordProof(root, original, passingRun(false), options), false);
  assert.equal(recordProof(root, moved, passingRun(false), options), true);

  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const newBase = captureProof(root);
  assert.ok(newBase);
  assert.equal(newBase.fingerprint.tree, moved.fingerprint.tree);
  assert.notEqual(newBase.key, moved.key);
  assert.equal(hasProof(root, newBase.committed, newBase.key), false);
});
