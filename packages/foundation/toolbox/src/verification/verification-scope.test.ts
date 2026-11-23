/** Proves changed-scope discovery and candidate planning fail closed before reuse exists. */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDadsProject } from "../project-orientation.js";
import { recommendChangedVerification } from "../recommend-changed-verification.js";
import { collectCandidateTasks } from "./logic/collect-candidate-tasks.js";
import { environmentWithoutGitVariables } from "./git-environment.js";
import { readChangedScope } from "./read-changed-scope.js";
import { runVerificationTask } from "./run-verification-task.js";

const temporaryRepositories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true });
  }
});

describe("verification task candidates", () => {
  it("selects the configured full fallback when a default clean scope has no trusted baseline", () => {
    const project = parseDadsProject({
      schemaVersion: 2,
      packages: [packageDeclaration("toolbox", "packages/toolbox", [])],
      verification: {
        tasks: [verificationTask("toolbox:test", "toolbox", "packages/toolbox")],
        fullFallbackTaskIds: ["toolbox:test"],
      },
    });

    const recommendation = recommendChangedVerification(project, [], {
      trustEmptyScope: false,
    });

    expect(recommendation.usedFullFallback).toBe(true);
    expect(recommendation.tasks.map((task) => task.taskId)).toEqual(["toolbox:test"]);
    expect(recommendation.tasks[0]?.state).toBe("unknown-scope");
  });

  it("traverses dependent tasks and leaves reuse pending on provider proof", () => {
    const project = parseDadsProject({
      schemaVersion: 2,
      packages: [
        packageDeclaration("policy", "packages/policy", []),
        packageDeclaration("server", "packages/server", ["policy"]),
      ],
      verification: {
        tasks: [
          verificationTask("policy:check", "policy", "packages/policy"),
          {
            ...verificationTask("server:test", "server", "packages/server"),
            dependsOn: ["policy:check"],
            reusePolicy: "candidate",
          },
        ],
        fullFallbackTaskIds: ["policy:check", "server:test"],
      },
    });

    const plan = collectCandidateTasks(project, ["packages/policy/src/access.ts"]);

    expect(plan.tasks.map(({ taskId, state }) => ({ taskId, state }))).toEqual([
      { taskId: "policy:check", state: "run" },
      { taskId: "server:test", state: "pending-provider" },
    ]);
    expect(plan.complete).toBe(true);
  });

  it("includes execution prerequisites before a directly changed task", () => {
    const project = parseDadsProject({
      schemaVersion: 2,
      packages: [
        packageDeclaration("policy", "packages/policy", []),
        packageDeclaration("server", "packages/server", ["policy"]),
      ],
      verification: {
        tasks: [
          verificationTask("policy:check", "policy", "packages/policy"),
          {
            ...verificationTask("server:test", "server", "packages/server"),
            dependsOn: ["policy:check"],
          },
        ],
        fullFallbackTaskIds: ["policy:check", "server:test"],
      },
    });

    const plan = collectCandidateTasks(project, ["packages/server/src/read-document.ts"]);

    expect(plan.tasks.map((task) => task.taskId)).toEqual(["policy:check", "server:test"]);
  });

  it("uses a declared non-source check for documentation history", () => {
    const project = parseDadsProject({
      schemaVersion: 2,
      packages: [packageDeclaration("toolbox", "packages/toolbox", [])],
      verification: {
        tasks: [
          {
            ...verificationTask("docs:check", "toolbox", "packages/toolbox"),
            sourceInputs: [],
            nonSourceInputs: ["docs", ".agents/plans"],
          },
        ],
        fullFallbackTaskIds: ["docs:check"],
      },
    });

    const plan = collectCandidateTasks(project, [".agents/plans/verification.md"]);

    expect(plan.tasks.map((task) => task.taskId)).toEqual(["docs:check"]);
    expect(plan.unknownPaths).toEqual([]);
    expect(plan.unownedPaths).toEqual([".agents/plans/verification.md"]);
  });

  it("keeps the more conservative state when one task is selected twice", () => {
    const project = parseDadsProject({
      schemaVersion: 2,
      packages: [packageDeclaration("toolbox", "packages/toolbox", [])],
      verification: {
        tasks: [verificationTask("toolbox:test", "toolbox", "packages/toolbox")],
        fullFallbackTaskIds: ["toolbox:test"],
      },
    });

    const plan = collectCandidateTasks(project, ["packages/toolbox/src/cli.ts", "tools/release.mjs"]);

    expect(plan.tasks.map(({ taskId, state }) => ({ taskId, state }))).toEqual([
      { taskId: "toolbox:test", state: "unknown-scope" },
    ]);
    expect(plan.tasks[0]?.reason).toBe(
      "packages/toolbox/src/cli.ts changed. The changed scope includes tools/release.mjs.",
    );
  });

  it("reports unknown scope incomplete when no safe fallback is configured", () => {
    const project = parseDadsProject({
      schemaVersion: 2,
      packages: [packageDeclaration("toolbox", "packages/toolbox", [])],
      verification: {
        tasks: [verificationTask("toolbox:test", "toolbox", "packages/toolbox")],
        fullFallbackTaskIds: [],
      },
    });

    const plan = collectCandidateTasks(project, ["tools/release.mjs"]);

    expect(plan.complete).toBe(false);
    expect(plan.tasks).toEqual([]);
    expect(plan.issues).toEqual(["Unknown changed paths have no configured full fallback task."]);
  });

  it("detects dependency cycles instead of pruning them", () => {
    const project = parseDadsProject({
      schemaVersion: 2,
      packages: [packageDeclaration("toolbox", "packages/toolbox", [])],
      verification: {
        tasks: [
          {
            ...verificationTask("first", "toolbox", "packages/toolbox"),
            dependsOn: ["second"],
          },
          {
            ...verificationTask("second", "toolbox", "packages/toolbox"),
            dependsOn: ["first"],
          },
        ],
        fullFallbackTaskIds: ["first", "second"],
      },
    });

    const plan = collectCandidateTasks(project, ["packages/toolbox/src/cli.ts"]);

    expect(plan.complete).toBe(false);
    expect(plan.tasks.map((task) => task.taskId)).toEqual(["first", "second"]);
    expect(plan.issues).toEqual(["The verification task graph contains a dependency cycle."]);
  });
});

describe("git changed scope", () => {
  it("finds committed changes on a clean branch from an explicit base", () => {
    const repository = createGitRepository();
    const base = git(repository, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repository, "source.ts"), "export const value = 2;\n");
    git(repository, ["add", "source.ts"]);
    git(repository, ["commit", "-m", "change source"]);

    expect(readChangedScope(repository, { baseRef: base }).paths).toEqual(["source.ts"]);
  });

  it("preserves staged, unstaged, untracked, deleted and both renamed paths", () => {
    const repository = createGitRepository();
    const base = git(repository, ["rev-parse", "HEAD"]).trim();
    renameSync(join(repository, "rename-old.ts"), join(repository, "renamed file.ts"));
    rmSync(join(repository, "delete.ts"));
    writeFileSync(join(repository, "source.ts"), "export const value = 2;\n");
    git(repository, ["add", "--all"]);
    writeFileSync(join(repository, "source.ts"), "export const value = 3;\n");
    writeFileSync(join(repository, "untracked\nfile.ts"), "untracked\n");

    expect(readChangedScope(repository, { baseRef: base }).paths).toEqual([
      "delete.ts",
      "rename-old.ts",
      "renamed file.ts",
      "source.ts",
      "untracked\nfile.ts",
    ]);
  });

  it("reads the requested root when the environment names another repository", () => {
    const repository = createGitRepository();
    const hookRepository = createGitRepository();
    const base = git(repository, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repository, "source.ts"), "export const value = 2;\n");
    git(repository, ["add", "source.ts"]);
    git(repository, ["commit", "-m", "change source"]);
    vi.stubEnv("GIT_DIR", join(hookRepository, ".git"));
    vi.stubEnv("GIT_WORK_TREE", hookRepository);

    expect(readChangedScope(repository, { baseRef: base }).paths).toEqual(["source.ts"]);
    expect(git(hookRepository, ["status", "--porcelain"])).toBe("");
  });

  it("rejects an invalid explicit base", () => {
    const repository = createGitRepository();

    expect(() => readChangedScope(repository, { baseRef: "missing-verification-base" })).toThrow(
      /invalid verification base/i,
    );
  });
});

describe("verification task execution", () => {
  it("reports command launch failures as non-success", () => {
    const repository = createGitRepository();
    const failedExecution = runVerificationTask(
      repository,
      {
        taskId: "missing-command",
        packageName: "toolbox",
        command: "dads-command-that-does-not-exist",
        state: "run",
        reason: "Proves launch failures remain visible.",
        dependsOn: [],
      },
      true,
    );

    expect(failedExecution.passed).toBe(false);
    expect(failedExecution.exitCode).not.toBe(0);
    expect(failedExecution.error).toMatch(/not found/i);
  });
});

function packageDeclaration(name: string, root: string, allowedDependencies: readonly string[]): object {
  return {
    name,
    root,
    responsibility: `Owns ${name}.`,
    allowedDependencies,
    verification: [`npm test -w ${name}`],
    skills: ["dads-orient"],
  };
}

function verificationTask(id: string, packageName: string, sourceInput: string): object {
  return {
    id,
    packageName,
    command: `npm test -w ${packageName}`,
    dependsOn: [],
    sourceInputs: [sourceInput],
    nonSourceInputs: [],
    reusePolicy: "never",
  };
}

function createGitRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "dads-verification-scope-"));
  temporaryRepositories.push(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "verification@example.test"]);
  git(repository, ["config", "user.name", "Verification Test"]);
  mkdirSync(join(repository, "nested"));
  writeFileSync(join(repository, "source.ts"), "export const value = 1;\n");
  writeFileSync(join(repository, "delete.ts"), "delete me\n");
  writeFileSync(join(repository, "rename-old.ts"), "rename me\n");
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "-m", "initial"]);
  return repository;
}

function git(repository: string, argumentsForGit: readonly string[]): string {
  const completed = spawnSync("git", argumentsForGit, {
    cwd: repository,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(`${completed.stderr}\n${completed.stdout}`.trim());
  }
  return completed.stdout;
}
