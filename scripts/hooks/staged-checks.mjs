import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { recordHookTiming } from "./record-hook-timing.mjs";
import { isCleanWorktree } from "./staged-clean-worktree.mjs";
import { linkStagedDependencies } from "./staged-dependencies.mjs";
import { applyStagedFixes } from "./staged-fixes.mjs";
import {
  changedIndexPaths,
  git,
  isRegular,
  treeEntries,
  writeSnapshot,
} from "./staged-snapshot.mjs";

const lintable = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const formattable = /\.(?:json|md|css|html|yml|yaml)$/;

function needsProof(path) {
  return lintable.test(path) || formattable.test(path) || path.endsWith(".rs");
}

function runNode(cwd, executable, args, tool, pathCount) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${tool} could not start.`, { cause: result.error });
  }
  if (result.status !== 0) {
    const paths = pathCount === 1 ? "path" : "paths";
    throw new Error(
      `${tool} failed while checking ${pathCount} staged ${paths}.`,
    );
  }
}

function checkText(root, worktree, paths, fix) {
  const formatPaths = paths.filter(
    (path) => formattable.test(path) || lintable.test(path),
  );
  const lintPaths = paths.filter((path) => lintable.test(path));
  return (
    runTextTool(root, worktree, fix, formatPaths, "prettier/bin/prettier.cjs", [
      fix ? "--write" : "--check",
      "--ignore-unknown",
      "--log-level",
      "warn",
    ]) &&
    runTextTool(root, worktree, fix, lintPaths, "eslint/bin/eslint.js", [
      ...(fix ? ["--fix"] : []),
      "--no-warn-ignored",
    ])
  );
}

function runTextTool(root, worktree, fix, paths, executable, options) {
  if (paths.length === 0) return true;
  const binary = join(root, "node_modules", executable);
  const args = [...options, "--", ...paths.map((path) => `./${path}`)];
  if (fix) {
    const tool = executable.startsWith("eslint/") ? "ESLint" : "Prettier";
    runNode(worktree, binary, args, tool, paths.length);
    return true;
  }
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: worktree,
    stdio: "ignore",
  });
  return result.status === 0;
}

function checkBudgets(root, snapshot, paths) {
  const measured = paths.filter(
    (path) => lintable.test(path) || path.endsWith(".rs"),
  );
  if (measured.length === 0) return;
  const toolbox = join(root, "packages/foundation/toolbox");
  if (!existsSync(join(toolbox, "dist/cli.js"))) {
    throw new Error(
      "The source ratchet needs a built toolbox. Run npm run build first.",
    );
  }
  runNode(
    snapshot,
    join(toolbox, "bin/dad.js"),
    [
      "doctor",
      snapshot,
      ...measured.flatMap((path) => ["--file", `./${path}`]),
    ],
    "Source budgets",
    measured.length,
  );
}

function runStagedChecks(root) {
  const before = git(root, ["write-tree"], { encoding: "utf8" }).trim();
  const changed = new Set([...changedIndexPaths(root)].filter(needsProof));
  if (changed.size === 0) return;
  const paths = treeEntries(root, before)
    .filter((entry) => isRegular(entry) && changed.has(entry.path))
    .map((entry) => entry.path);
  if (paths.length === 0) return;
  if (checkCleanWorktree(root, before, paths)) return;
  checkSnapshot(root, before, changed, paths);
}

function checkCleanWorktree(root, before, paths) {
  if (!isCleanWorktree(root) || !checkText(root, root, paths, false))
    return false;
  checkBudgets(root, root, paths);
  const after = git(root, ["write-tree"], { encoding: "utf8" }).trim();
  return before === after && isCleanWorktree(root);
}

function checkSnapshot(root, before, changed, paths) {
  const scratch = mkdtempSync(join(tmpdir(), "dads-staged-"));
  try {
    const snapshot = join(scratch, "tree");
    mkdirSync(snapshot);
    const files = writeSnapshot(root, before, snapshot, changed);
    linkStagedDependencies(root, snapshot);
    checkText(root, snapshot, paths, true);
    checkBudgets(root, snapshot, paths);
    applyStagedFixes(root, scratch, snapshot, before, files);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const startedAt = performance.now();
try {
  runStagedChecks(process.cwd());
} catch (error) {
  process.stderr.write(`pre-commit: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  recordHookTiming("pre-commit", startedAt);
}
