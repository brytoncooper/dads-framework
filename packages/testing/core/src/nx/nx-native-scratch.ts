import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nativeNxProcess } from "./nx-native-process.js";

/** Scratch must already be ignored and must remain physically inside this workspace. */
export async function createNativeNxScratch(
  workspaceRoot: string,
): Promise<string> {
  for (const directory of [
    "node_modules/.cache/dads-testing",
    ".nx/dads-testing",
    "tmp/dads-testing",
  ]) {
    if (!(await safeIgnoredDirectory(workspaceRoot, directory))) continue;
    const absolute = path.join(workspaceRoot, directory);
    await fs.mkdir(absolute, { recursive: true });
    if (!inside(workspaceRoot, await fs.realpath(absolute))) continue;
    const scratch = await fs.mkdtemp(path.join(absolute, "nx-"));
    try {
      await nativeNxProcess(
        "git",
        ["check-ignore", "--quiet", "--", `${scratch}/`],
        workspaceRoot,
      );
      return scratch;
    } catch {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  throw new Error(
    "The Nx adapter needs an ignored scratch directory inside the workspace. Add tmp/ to .gitignore (or use an in-workspace node_modules directory).",
  );
}

async function safeIgnoredDirectory(
  workspaceRoot: string,
  directory: string,
): Promise<boolean> {
  try {
    await nativeNxProcess(
      "git",
      ["check-ignore", "--quiet", "--", `${directory}/`],
      workspaceRoot,
    );
    return inside(
      workspaceRoot,
      await existingParent(workspaceRoot, directory),
    );
  } catch {
    return false;
  }
}

async function existingParent(
  workspaceRoot: string,
  directory: string,
): Promise<string> {
  let existing = path.join(workspaceRoot, directory);
  while (existing !== workspaceRoot) {
    try {
      return await fs.realpath(existing);
    } catch (error: unknown) {
      if (!missing(error)) throw error;
      existing = path.dirname(existing);
    }
  }
  return workspaceRoot;
}

/** Bind discovery to the exact Git-visible working tree, including untracked source. */
export async function nativeNxSourceIdentity(
  workspaceRoot: string,
): Promise<string> {
  const [head, diff, untracked] = await Promise.all([
    nativeNxProcess("git", ["rev-parse", "--verify", "HEAD"], workspaceRoot),
    nativeNxProcess(
      "git",
      ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
      workspaceRoot,
    ),
    nativeNxProcess(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      workspaceRoot,
    ),
  ]);
  const digest = createHash("sha256").update(head).update("\0").update(diff);
  for (const relative of untracked.split("\0").filter(Boolean).sort()) {
    const absolute = path.resolve(workspaceRoot, relative);
    if (!inside(workspaceRoot, absolute))
      throw new Error("Git reported a path outside the workspace.");
    const metadata = await fs.lstat(absolute);
    const content = metadata.isSymbolicLink()
      ? await fs.readlink(absolute)
      : await fs.readFile(absolute);
    digest.update("\0").update(relative).update("\0").update(content);
  }
  return digest.digest("hex");
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
