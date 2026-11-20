import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { environmentWithoutGitVariables } from "./git-environment.js";
import { readSnapshotGitEvidence } from "./workspace-git-evidence.js";
import {
  captureWorkspaceSnapshot,
  discardWorkspaceSnapshot,
  readWorkspaceIdentity,
} from "./workspace-snapshot.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    env: environmentWithoutGitVariables(),
    encoding: "utf8",
  }).trim();
}

it("retains read-only history and hook facts in an offline graph snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "dads-git-context-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=work");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.test");
  mkdirSync(join(root, ".githooks"));
  writeFileSync(join(root, ".githooks/pre-commit"), "exit 1\n");
  git(root, "add", ".githooks/pre-commit");
  git(root, "commit", "--quiet", "-m", "initial fixture");
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const boundary = git(root, "commit-tree", tree, "-m", "published boundary");
  git(root, "update-ref", "refs/remotes/origin/main", boundary);
  git(root, "remote", "add", "origin", "https://example.invalid/no-network");
  git(root, "config", "core.hooksPath", ".githooks");

  const identity = readWorkspaceIdentity(root);
  const snapshot = captureWorkspaceSnapshot(root, identity);
  try {
    expect(git(snapshot.root, "rev-parse", "origin/main")).toBe(boundary);
    expect(git(snapshot.root, "cat-file", "-t", boundary)).toBe("commit");
    expect(
      git(snapshot.root, "config", "--local", "--get", "core.hooksPath"),
    ).toBe(".githooks");
    expect(git(snapshot.root, "remote")).toBe("");
  } finally {
    discardWorkspaceSnapshot(snapshot);
  }

  git(
    root,
    "update-ref",
    "refs/remotes/origin/main",
    git(root, "rev-parse", "HEAD"),
  );
  expect(git(root, "remote")).toBe("origin");
  expect(git(root, "config", "--local", "--get", "core.hooksPath")).toBe(
    ".githooks",
  );
  expect(readWorkspaceIdentity(root)).not.toBe(identity);
  const movedBoundaryIdentity = readWorkspaceIdentity(root);
  git(root, "config", "core.hooksPath", "verification-hooks");
  expect(readWorkspaceIdentity(root)).not.toBe(movedBoundaryIdentity);
  expect(() => captureWorkspaceSnapshot(root, identity)).toThrow(
    /identity changed/,
  );
});

it("keeps absolute and escaping hook paths out of snapshot configuration", () => {
  for (const path of ["/etc/hooks", "../hooks", ".git/hooks", "C:\\hooks"]) {
    const evidence = readSnapshotGitEvidence((args) => ({
      status: args[0] === "config" ? 0 : 1,
      stdout: args[0] === "config" ? path : "",
    }));
    expect(evidence.hooksPath).toBeUndefined();
  }
});
