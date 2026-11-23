import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isCleanWorktree } from "./staged-clean-worktree.mjs";
import { applyStagedFixes } from "./staged-fixes.mjs";
import { changedIndexPaths, git, writeSnapshot } from "./staged-snapshot.mjs";

const path = "--draft [final]\nnotes.md";

function createStagedFixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), "dads-staged-test-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "repo");
  const snapshot = join(scratch, "tree");
  mkdirSync(root);
  mkdirSync(snapshot);
  git(root, ["init", "--quiet"]);
  writeFileSync(join(root, path), "staged  \n");
  git(root, ["--literal-pathspecs", "add", "--", path]);

  const before = git(root, ["write-tree"], { encoding: "utf8" }).trim();
  const paths = changedIndexPaths(root);
  const files = writeSnapshot(root, before, snapshot, paths);
  return { root, scratch, snapshot, before, paths, files };
}

test("the staged snapshot keeps unusual names and reads only staged bytes", (t) => {
  const { root, scratch, before, paths } = createStagedFixture(t);
  writeFileSync(join(root, path), "unstaged\n");
  const destination = join(scratch, "fresh");
  mkdirSync(destination);

  const files = writeSnapshot(root, before, destination, paths);
  assert.deepEqual([...files.keys()], [path]);
  assert.equal(readFileSync(join(destination, path), "utf8"), "staged  \n");
  assert.equal(readFileSync(join(root, path), "utf8"), "unstaged\n");
});

test("valid fixes are applied to the index and its matching working file", (t) => {
  const { root, scratch, snapshot, before, files } = createStagedFixture(t);
  writeFileSync(join(snapshot, path), "fixed\n");

  applyStagedFixes(root, scratch, snapshot, before, files);

  assert.equal(git(root, ["show", `:${path}`], { encoding: "utf8" }), "fixed\n");
  assert.equal(readFileSync(join(root, path), "utf8"), "fixed\n");
});

test("autofix preserves both versions of a partially staged file", (t) => {
  const { root, scratch, snapshot, before, files } = createStagedFixture(t);
  writeFileSync(join(root, path), "unstaged\n");
  writeFileSync(join(snapshot, path), "fixed\n");

  assert.throws(() => applyStagedFixes(root, scratch, snapshot, before, files), /Staged fixes could not be applied/);

  assert.equal(git(root, ["show", `:${path}`], { encoding: "utf8" }), "staged  \n");
  assert.equal(readFileSync(join(root, path), "utf8"), "unstaged\n");
});

test("an ignored local formatter config prevents worktree proof", (t) => {
  const { root } = createStagedFixture(t);
  writeFileSync(join(root, ".git/info/exclude"), ".prettierrc\n");
  writeFileSync(join(root, ".prettierrc"), "{invalid config");
  assert.equal(isCleanWorktree(root), false);
});

test("an assume-unchanged file prevents worktree proof", (t) => {
  const { root } = createStagedFixture(t);
  git(root, ["--literal-pathspecs", "update-index", "--assume-unchanged", "--", path]);
  writeFileSync(join(root, path), "hidden unstaged edit\n");
  assert.equal(isCleanWorktree(root), false);
});
