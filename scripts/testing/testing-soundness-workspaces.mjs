import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  applyFixtureOperations,
  copyDirectory,
  removeTemporaryDirectory,
  sha256File,
} from "./testing-soundness-lib.mjs";
import {
  assertObservedTasks,
  assertValidBaseline,
  executeTasksIndependently,
  loadTaskManifest,
  stageWorkspaceTools,
} from "./testing-soundness-execution.mjs";

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function freezeBaseline(source, manifest) {
  const workspace = temporaryWorkspace();
  try {
    copyDirectory(source, workspace);
    writeFileSync(join(workspace, "dads.testing.json"), readFileSync(manifest));
    git(workspace, ["init", "--quiet"]);
    configureGit(workspace);
    git(workspace, ["add", "--all"]);
    git(workspace, ["commit", "--quiet", "--message", "baseline"]);
    return {
      workspace,
      base: git(workspace, ["rev-parse", "HEAD"]),
      tree: git(workspace, ["rev-parse", "HEAD^{tree}"]),
      manifestSha256: sha256File(join(workspace, "dads.testing.json")),
      manifest: loadTaskManifest(join(workspace, "dads.testing.json")),
    };
  } catch (error) {
    removeWorkspace(workspace);
    throw error;
  }
}

export function cloneBaseline(frozen, testCase) {
  const workspace = temporaryWorkspace();
  try {
    git(workspace, ["clone", "--quiet", "--no-local", frozen.workspace, "."]);
    configureGit(workspace);
    if (testCase) {
      applyFixtureOperations(workspace, testCase.operations);
      git(workspace, ["add", "--all"]);
      git(workspace, [
        "commit",
        "--quiet",
        "--message",
        `mutation ${testCase.id}`,
      ]);
    }
    return {
      workspace,
      base: frozen.base,
      head: git(workspace, ["rev-parse", "HEAD"]),
    };
  } catch (error) {
    removeWorkspace(workspace);
    throw error;
  }
}

export async function observeBaseline(
  root,
  frozen,
  timings,
  environment = {},
  taskJobs = 1,
) {
  const receipt = {
    base: frozen.base,
    tree: frozen.tree,
    manifestSha256: frozen.manifestSha256,
    outcomes: [],
    executionError: null,
  };
  const setupStarted = performance.now();
  let baseline;
  try {
    baseline = cloneBaseline(frozen);
    stageWorkspaceTools(root, baseline.workspace);
    timings.setupMs += performance.now() - setupStarted;
    const started = performance.now();
    try {
      receipt.outcomes = await executeTasksIndependently(
        frozen.manifest.tasks,
        baseline.workspace,
        environment,
        taskJobs,
      );
      assertObservedTasks(frozen.manifest.tasks, receipt.outcomes, "Baseline");
      assertValidBaseline(receipt.outcomes);
    } finally {
      timings.baselineMs += performance.now() - started;
    }
  } catch (error) {
    receipt.executionError =
      error instanceof Error ? error.message : String(error);
  } finally {
    removeWorkspace(baseline?.workspace);
  }
  return receipt;
}

export function removeWorkspace(workspace) {
  if (workspace) removeTemporaryDirectory(workspace, "dads-testing-soundness-");
}

function temporaryWorkspace() {
  return mkdtempSync(
    join(process.env.TMPDIR || "/tmp", "dads-testing-soundness-"),
  );
}

function configureGit(workspace) {
  git(workspace, ["config", "user.email", "soundness@dads.invalid"]);
  git(workspace, ["config", "user.name", "Dads testing soundness"]);
}
