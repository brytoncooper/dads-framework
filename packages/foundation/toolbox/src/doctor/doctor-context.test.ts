/** Proves `DoctorContext` and git-history helpers handle fresh `git init` and `--existing` subprojects. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { environmentWithoutGitVariables } from "../verification/git-environment.js";
import { createDoctorContext } from "./doctor-context.js";
import { isGitWorkspace, readCommitLog, readFileAtRevision } from "./signals/scanners/git-history.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("doctor context git discovery", () => {
  it("lists untracked hand-written files right after git init so tsconfig.json is found", () => {
    const root = makeTempDir("dad-doctor-empty-git-");
    git(root, "init", "--quiet", "-b", "main");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, "src", "app.ts"), "export const ready = true;\n");
    writeFileSync(join(root, "ignored.ts"), "export const ignored = true;\n");

    const context = createDoctorContext({ root });
    expect(context.files()).toContain("tsconfig.json");
    expect(context.files()).toContain("src/app.ts");
    expect(context.files()).not.toContain("ignored.ts");
    expect(context.program().modules.map((module) => module.path)).toContain("src/app.ts");
  });

  it("recognizes an --existing subproject inside an enclosing git worktree and scopes files and log to it", () => {
    const repo = makeTempDir("dad-doctor-existing-subproject-");
    const subproject = join(repo, "dads");
    git(repo, "init", "--quiet", "-b", "main");
    git(repo, "config", "user.name", "Doctor Fixture");
    git(repo, "config", "user.email", "fixture@dads.invalid");
    git(repo, "config", "commit.gpgsign", "false");

    writeFileSync(join(repo, "host.ts"), "export const host = 1;\n");
    git(repo, "add", "host.ts");
    git(repo, "commit", "-qm", "host only commit");

    mkdirSync(join(subproject, "src"), { recursive: true });
    writeFileSync(join(subproject, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(subproject, "src", "feature.ts"), "export const feature = 1;\n");
    git(repo, "add", "dads/tsconfig.json", "dads/src/feature.ts");
    git(repo, "commit", "-qm", "add dads subproject");
    const sha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(subproject, "src", "untracked.ts"), "export const untracked = 2;\n");

    const context = createDoctorContext({ root: subproject });
    expect(context.files().slice().sort()).toEqual(["src/feature.ts", "src/untracked.ts", "tsconfig.json"]);
    expect(isGitWorkspace(subproject)).toBe(true);

    const commits = readCommitLog(subproject);
    expect(commits.map((commit) => commit.message)).toEqual(["add dads subproject"]);
    expect(commits[0]?.changes.map((change) => change.path).sort()).toEqual(["src/feature.ts", "tsconfig.json"]);
    expect(readFileAtRevision(subproject, sha, "src/feature.ts")).toBe("export const feature = 1;\n");
  });
});
