import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { environmentWithoutGitVariables } from "./git-environment.js";
import { readWorkspaceIdentity } from "./workspace-snapshot.js";

export type ChangedScope = {
  readonly comparisonBase: string;
  readonly paths: readonly string[];
  readonly workspaceIdentity: string;
};

export type ReadChangedScopeOptions = {
  readonly baseRef?: string;
};

/** One `git diff --name-status -z` record: its paths and where the next record starts. */
type ChangeRecord = {
  readonly paths: readonly string[];
  readonly nextFieldIndex: number;
};

export function readChangedScope(
  projectRoot: string,
  options: ReadChangedScopeOptions = {},
): ChangedScope {
  const requestedBase = options.baseRef ?? "HEAD";
  const comparisonBase = resolveCommit(projectRoot, requestedBase);
  const trackedChanges = readTrackedChanges(projectRoot, comparisonBase);
  const untrackedChanges = readNullSeparatedPaths(
    runGitForOutput(projectRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  );
  return {
    comparisonBase,
    paths: [...new Set([...trackedChanges, ...untrackedChanges])].sort(),
    workspaceIdentity: readWorkspaceIdentity(projectRoot),
  };
}

function resolveCommit(projectRoot: string, requestedBase: string): string {
  const completed = spawnGit(projectRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${requestedBase}^{commit}`,
  ]);
  if (completed.error) {
    throw new Error(`Unable to launch git: ${completed.error.message}`);
  }
  if (completed.status !== 0) {
    throw new Error(`Invalid verification base ${requestedBase}.`);
  }
  return completed.stdout.trim();
}

function readTrackedChanges(
  projectRoot: string,
  comparisonBase: string,
): readonly string[] {
  const fields = readChangeFields(
    runGitForOutput(projectRoot, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      comparisonBase,
      "--",
    ]),
  );
  const paths: string[] = [];
  let fieldIndex = 0;
  while (fieldIndex < fields.length) {
    const record = readChangeRecord(fields, fieldIndex);
    paths.push(...record.paths);
    fieldIndex = record.nextFieldIndex;
  }
  return paths;
}

function readChangeFields(output: string): readonly string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function readChangeRecord(
  fields: readonly string[],
  statusIndex: number,
): ChangeRecord {
  const status = fields[statusIndex];
  if (!status) throw new Error("Git returned a changed path without a status.");
  if (status.startsWith("R") || status.startsWith("C")) {
    const previousPath = fields[statusIndex + 1];
    const currentPath = fields[statusIndex + 2];
    if (!previousPath || !currentPath) {
      throw new Error("Git returned an incomplete rename or copy record.");
    }
    return {
      paths: [previousPath, currentPath],
      nextFieldIndex: statusIndex + 3,
    };
  }
  const changedPath = fields[statusIndex + 1];
  if (!changedPath) {
    throw new Error("Git returned an incomplete change record.");
  }
  return { paths: [changedPath], nextFieldIndex: statusIndex + 2 };
}

function readNullSeparatedPaths(output: string): readonly string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

/** Runs git for its stdout, refusing any failure; `workspace-git-context.ts` has `runSourceGit` for a result. */
function runGitForOutput(
  projectRoot: string,
  argumentsForGit: readonly string[],
): string {
  const completed = spawnGit(projectRoot, argumentsForGit);
  if (completed.error) {
    throw new Error(`Unable to launch git: ${completed.error.message}`);
  }
  if (completed.status !== 0) {
    const detail = completed.stderr.trim();
    throw new Error(
      detail.length > 0
        ? `Unable to read the changed git scope: ${detail}`
        : "Unable to read the changed git scope.",
    );
  }
  return completed.stdout;
}

/**
 * Every `git` here runs against the root it was handed, never against a
 * repository a caller's environment names.
 */
function spawnGit(
  projectRoot: string,
  argumentsForGit: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSync("git", argumentsForGit, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
}
