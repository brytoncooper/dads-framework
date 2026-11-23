import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execute("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  return result.stdout.trimEnd();
}

export async function findRepository(cwd: string) {
  const worktree = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const sharedGitDir = resolve(worktree, await git(worktree, ["rev-parse", "--git-common-dir"]));
  return { worktree, sharedGitDir };
}

export type GitWorktree = {
  readonly path: string;
  readonly head: string;
  readonly primary: boolean;
  readonly locked: boolean;
};

export async function gitWorktrees(cwd: string): Promise<GitWorktree[]> {
  const porcelain = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  return porcelain.split("\0\0").flatMap((record, index) => {
    const rows = record.split("\0");
    const path = rows.find((row) => row.startsWith("worktree "))?.slice(9);
    const head = rows.find((row) => row.startsWith("HEAD "))?.slice(5);
    return path === undefined || head === undefined
      ? []
      : [
          {
            path,
            head,
            primary: index === 0,
            locked: rows.some((row) => row === "locked" || row.startsWith("locked ")),
          },
        ];
  });
}

export async function isDirty(path: string): Promise<boolean> {
  return (await git(path, ["status", "--porcelain=v1", "--untracked-files=all"])).length > 0;
}
