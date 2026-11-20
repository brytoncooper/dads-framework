import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentWithoutGitVariables } from "./git-environment.js";
import {
  captureWorkspaceSnapshot,
  discardWorkspaceSnapshot,
  readWorkspaceIdentity,
} from "./workspace-snapshot.js";

const privateReferencesScript = fileURLToPath(
  new URL(
    "../../../../../scripts/checks/check-private-references.mjs",
    import.meta.url,
  ),
);
const temporaryProjects: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const projectRoot of temporaryProjects.splice(0)) {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("Git workspace snapshots", () => {
  it("gives root Git verification a clean independent repository and captured HEAD", () => {
    const projectRoot = createCommittedRepository();
    git(projectRoot, ["branch", "-M", "main"]);
    const expectedHead = git(projectRoot, ["rev-parse", "HEAD"]).trim();
    const snapshot = captureSnapshot(projectRoot);

    expect(
      realpathSync(git(snapshot.root, ["rev-parse", "--show-toplevel"]).trim()),
    ).toBe(realpathSync(snapshot.root));
    expect(git(snapshot.root, ["rev-parse", "HEAD"]).trim()).toBe(expectedHead);
    expect(git(snapshot.root, ["rev-parse", "refs/heads/main"]).trim()).toBe(
      expectedHead,
    );
    expect(
      git(snapshot.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    ).toBe("HEAD");
    expect(git(snapshot.root, ["remote"]).trim()).toBe("");
    expect(git(projectRoot, ["branch", "--show-current"]).trim()).toBe("main");
    expect(git(snapshot.root, ["ls-files", "-z"]).split("\0")).toEqual(
      expect.arrayContaining(["clean.txt", "tracked.txt"]),
    );

    const result = runPrivateReferenceCheck(snapshot.root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/private references: clean/);
    discardWorkspaceSnapshot(snapshot);
  });

  it.each([
    ["tracked", "tracked.txt", false],
    ["staged-new", "staged-new-hit.txt", true],
    ["untracked", "untracked-hit.txt", false],
  ])(
    "copies %s source content into the Git inventory so planted references fail",
    (_state, relativePath, stage) => {
      const projectRoot = createCommittedRepository();
      const absolutePath = join(projectRoot, relativePath);
      writeFileSync(absolutePath, `see ${localWorkspaceReference()}\n`);
      if (stage) git(projectRoot, ["add", "--", relativePath]);

      const snapshot = captureSnapshot(projectRoot);
      const result = runPrivateReferenceCheck(snapshot.root);

      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(
        new RegExp(`${escapeRegExp(relativePath)}:1: local-machine-path`),
      );
      discardWorkspaceSnapshot(snapshot);
    },
  );

  it("does not copy ignored notes or node_modules into the snapshot inventory", () => {
    const projectRoot = createCommittedRepository([
      ".gitignore",
      "notes.txt\nnode_modules/\n",
    ]);
    writeFileSync(
      join(projectRoot, "notes.txt"),
      `see ${localWorkspaceReference("ignored-notes")}\n`,
    );
    mkdirSync(join(projectRoot, "node_modules", "ignored-package"), {
      recursive: true,
    });
    writeFileSync(
      join(projectRoot, "node_modules", "ignored-package", "index.js"),
      `see ${localWorkspaceReference("ignored-node-modules")}\n`,
    );

    const snapshot = captureSnapshot(projectRoot);
    const result = runPrivateReferenceCheck(snapshot.root);

    expect(result.status).toBe(0);
    expect(existsSync(join(snapshot.root, "notes.txt"))).toBe(true);
    expect(existsSync(join(snapshot.root, "node_modules"))).toBe(true);
    expect(git(snapshot.root, ["ls-files", "-z"])).not.toMatch(
      /notes\.txt|node_modules/,
    );
    discardWorkspaceSnapshot(snapshot);
  });

  it("includes a force-added ignored path with a literal tricky name", () => {
    const projectRoot = createCommittedRepository([
      ".gitignore",
      "force-added*\n",
    ]);
    const relativePath = "force-added\nhit.txt";
    writeFileSync(
      join(projectRoot, relativePath),
      `see ${localWorkspaceReference("force-added")}\n`,
    );
    git(projectRoot, ["add", "-f", "--", relativePath]);

    const snapshot = captureSnapshot(projectRoot);
    const inventory = git(snapshot.root, ["ls-files", "-z"]);
    const result = runPrivateReferenceCheck(snapshot.root);

    expect(inventory).toContain(`${relativePath}\0`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("local-machine-path");
    expect(result.stdout).toContain(relativePath);
    discardWorkspaceSnapshot(snapshot);
  });

  it("copies private patterns and allowlists used by the real reference checker", () => {
    const projectRoot = createCommittedRepository();
    writeFileSync(
      join(projectRoot, "scripts/checks/private-references.local.json"),
      JSON.stringify([
        {
          id: "zorblax-mention",
          regex: "Zorblax",
          files: "\\.md$",
          reason: "private codename",
        },
      ]),
    );
    writeFileSync(
      join(projectRoot, "scripts/checks/private-references.allow.json"),
      JSON.stringify([
        {
          path: "allowed.txt",
          pattern: "local-machine-path",
          reason: "reviewed fixture",
        },
      ]),
    );
    writeFileSync(
      join(projectRoot, "allowed.txt"),
      `see ${localWorkspaceReference("reviewed-project")}\n`,
    );
    writeFileSync(join(projectRoot, "docs.md"), "Zorblax lives here\n");
    git(projectRoot, ["add", "--all"]);

    const snapshot = captureSnapshot(projectRoot);
    const result = runPrivateReferenceCheck(snapshot.root);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(
      /allowed: allowed\.txt: local-machine-path \(reviewed fixture\)/,
    );
    expect(result.stdout).toMatch(/docs\.md:1: zorblax-mention/);
    discardWorkspaceSnapshot(snapshot);
  });

  it("stays fixed when the live source and index change after capture", () => {
    const projectRoot = createCommittedRepository();
    const expectedHead = git(projectRoot, ["rev-parse", "HEAD"]).trim();
    const identity = readWorkspaceIdentity(projectRoot);
    const snapshot = captureSnapshot(projectRoot, identity);

    writeFileSync(
      join(projectRoot, "tracked.txt"),
      `see ${localWorkspaceReference("changed-live-source")}\n`,
    );
    git(projectRoot, ["add", "tracked.txt"]);
    writeFileSync(join(projectRoot, "live-only.txt"), "live index change\n");
    git(projectRoot, ["add", "live-only.txt"]);

    expect(readFileSync(join(snapshot.root, "tracked.txt"), "utf8")).toBe(
      "tracked source\n",
    );
    expect(git(snapshot.root, ["rev-parse", "HEAD"]).trim()).toBe(expectedHead);
    expect(git(snapshot.root, ["ls-files", "-z"])).not.toContain(
      "live-only.txt",
    );
    expect(runPrivateReferenceCheck(snapshot.root).status).toBe(0);
    discardWorkspaceSnapshot(snapshot);
  });

  it("binds workspace identity to HEAD-only changes", () => {
    const projectRoot = createCommittedRepository();
    const identity = readWorkspaceIdentity(projectRoot);

    git(projectRoot, [
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "metadata-only",
    ]);

    expect(readWorkspaceIdentity(projectRoot)).not.toBe(identity);
  });

  it("preserves global source ignores without linking the snapshot to global configuration", () => {
    const projectRoot = createCommittedRepository();
    const configuration = mkdtempSync(join(tmpdir(), "dads-git-ignore-"));
    temporaryProjects.push(configuration);
    const ignorePath = join(configuration, "ignore");
    const configPath = join(configuration, "config");
    writeFileSync(ignorePath, "global-note.txt\n");
    git(projectRoot, [
      "config",
      "--file",
      configPath,
      "core.excludesFile",
      ignorePath,
    ]);
    vi.stubEnv("GIT_CONFIG_GLOBAL", configPath);
    writeFileSync(
      join(projectRoot, "global-note.txt"),
      localWorkspaceReference(),
    );

    const snapshot = captureSnapshot(projectRoot);
    expect(existsSync(join(snapshot.root, "global-note.txt"))).toBe(true);
    expect(git(snapshot.root, ["ls-files", "-z"])).not.toContain(
      "global-note.txt\0",
    );
    expect(runPrivateReferenceCheck(snapshot.root).status).toBe(0);
  });

  it("prunes HEAD entries removed from the source index while retaining their ignored bytes", () => {
    const projectRoot = createCommittedRepository([
      "notes.txt",
      "harmless baseline\n",
    ]);
    writeFileSync(join(projectRoot, ".gitignore"), "notes.txt\n");
    git(projectRoot, ["add", ".gitignore"]);
    git(projectRoot, ["commit", "--quiet", "-m", "ignore local notes"]);
    git(projectRoot, ["rm", "--cached", "notes.txt"]);
    writeFileSync(join(projectRoot, "notes.txt"), localWorkspaceReference());

    const snapshot = captureSnapshot(projectRoot);
    expect(existsSync(join(snapshot.root, "notes.txt"))).toBe(true);
    expect(git(snapshot.root, ["ls-files", "-z"])).not.toContain("notes.txt\0");
    expect(runPrivateReferenceCheck(snapshot.root).status).toBe(0);
  });

  it("rejects an unreadable Git inventory instead of treating the repository as a directory", () => {
    const projectRoot = createCommittedRepository();
    writeFileSync(join(projectRoot, ".git/index"), "broken index");
    expect(() => readWorkspaceIdentity(projectRoot)).toThrow(/Git.*inventory/);
  });

  it("rejects a corrupt existing HEAD instead of classifying it as unborn", () => {
    const projectRoot = createCommittedRepository();
    const headRef = git(projectRoot, ["symbolic-ref", "HEAD"]).trim();
    writeFileSync(join(projectRoot, ".git", headRef), `${"1".repeat(40)}\n`);
    expect(() => readWorkspaceIdentity(projectRoot)).toThrow(/Git.*HEAD/);
  });

  it("removes live Git remotes and alternates from copied metadata", () => {
    const projectRoot = createCommittedRepository();
    git(projectRoot, ["remote", "add", "origin", "https://live.example/repo"]);
    const snapshot = captureSnapshot(projectRoot);
    const gitDirectory = join(snapshot.root, ".git");

    const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: snapshot.root,
      encoding: "utf8",
      env: environmentWithoutGitVariables(),
    });
    expect(remote.status).not.toBe(0);
    expect(remote.stdout).toBe("");
    expect(existsSync(join(gitDirectory, "objects/info/alternates"))).toBe(
      false,
    );
    expect(lstatSync(gitDirectory).isSymbolicLink()).toBe(false);
    discardWorkspaceSnapshot(snapshot);
  });

  it("captures plain directories and lets path based verification scan them", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "dads-plain-workspace-"));
    temporaryProjects.push(projectRoot);
    mkdirSync(join(projectRoot, "scripts/checks"), { recursive: true });
    writeFileSync(
      join(projectRoot, "scripts/checks/check-private-references.mjs"),
      readFileSync(privateReferencesScript),
    );
    writeFileSync(join(projectRoot, "plain.txt"), "plain workspace\n");

    const identity = readWorkspaceIdentity(projectRoot);
    const snapshot = captureSnapshot(projectRoot, identity);

    expect(existsSync(join(snapshot.root, ".git"))).toBe(false);
    expect(readFileSync(join(snapshot.root, "plain.txt"), "utf8")).toBe(
      "plain workspace\n",
    );
    const result = runPrivateReferenceCheck(snapshot.root, true);
    expect(result.status).toBe(0);
    discardWorkspaceSnapshot(snapshot);
  });

  it("supports an unborn Git repository without inventing a HEAD", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "dads-unborn-workspace-"));
    temporaryProjects.push(projectRoot);
    git(projectRoot, ["init", "--quiet"]);
    mkdirSync(join(projectRoot, "scripts/checks"), { recursive: true });
    writeFileSync(
      join(projectRoot, "scripts/checks/check-private-references.mjs"),
      readFileSync(privateReferencesScript),
    );
    writeFileSync(join(projectRoot, "unborn.txt"), "unborn workspace\n");
    git(projectRoot, [
      "add",
      "unborn.txt",
      "scripts/checks/check-private-references.mjs",
    ]);

    const snapshot = captureSnapshot(projectRoot);
    expect(
      git(snapshot.root, ["rev-parse", "--is-inside-work-tree"]).trim(),
    ).toBe("true");
    expect(() => git(snapshot.root, ["rev-parse", "HEAD"])).toThrow();
    expect(git(snapshot.root, ["ls-files", "-z"])).toContain("unborn.txt\0");
    expect(runPrivateReferenceCheck(snapshot.root).status).toBe(0);
    discardWorkspaceSnapshot(snapshot);
  });
});

function createCommittedRepository(
  extraFile?: readonly [string, string],
): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-git-workspace-"));
  temporaryProjects.push(projectRoot);
  git(projectRoot, ["init", "--quiet"]);
  git(projectRoot, ["config", "user.email", "verification@example.test"]);
  git(projectRoot, ["config", "user.name", "Verification Test"]);
  mkdirSync(join(projectRoot, "scripts/checks"), { recursive: true });
  writeFileSync(
    join(projectRoot, "scripts/checks/check-private-references.mjs"),
    readFileSync(privateReferencesScript),
  );
  writeFileSync(join(projectRoot, "clean.txt"), "clean source\n");
  writeFileSync(join(projectRoot, "tracked.txt"), "tracked source\n");
  if (extraFile) writeFileSync(join(projectRoot, extraFile[0]), extraFile[1]);
  git(projectRoot, ["add", "--all"]);
  git(projectRoot, ["commit", "--quiet", "-m", "initial workspace"]);
  return projectRoot;
}

function captureSnapshot(projectRoot: string, expectedIdentity?: string) {
  const snapshot = captureWorkspaceSnapshot(
    projectRoot,
    expectedIdentity ?? readWorkspaceIdentity(projectRoot),
  );
  temporaryProjects.push(snapshot.root);
  return snapshot;
}

function runPrivateReferenceCheck(projectRoot: string, usePaths = false) {
  const scriptPath = realpathSync(
    join(projectRoot, "scripts/checks/check-private-references.mjs"),
  );
  const argumentsForCheck = usePaths
    ? [scriptPath, "--paths", projectRoot, "--root", projectRoot]
    : [scriptPath];
  const result = spawnSync(process.execPath, argumentsForCheck, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function git(
  projectRoot: string,
  argumentsAfterGit: readonly string[],
): string {
  const result = spawnSync("git", argumentsAfterGit, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${result.stderr.trim()}\n${result.stdout.trim()}`.trim());
  }
  return result.stdout;
}

function localWorkspaceReference(suffix = "private-project"): string {
  return ["", "Users", "someone", suffix].join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
